import { createHash } from 'node:crypto'
import http from 'node:http'
import { once } from 'node:events'

import { createZip } from './zip.mjs'

export const REPOSITORY = 'cloudopsworks/tronador-cli'

const RATE_LIMIT_BODY = JSON.stringify({
  message: "API rate limit exceeded for 20.1.2.3. (But here's the good news: Authenticated requests get a higher rate limit.)",
  documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api'
})

function rateLimitHeaders () {
  return {
    'content-type': 'application/json',
    'x-ratelimit-limit': '60',
    'x-ratelimit-remaining': '0',
    // Far enough out that the retry helper refuses to wait for it.
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600)
  }
}

/**
 * Serves both the REST API and the release download host for one repository.
 * `api` and `releases` select what each surface does: 'ok', 'rate-limit', or
 * 'error'. `throttledDownloads` answers that many asset downloads with a 403
 * before serving them. `cdnRedirect` redirects asset downloads to another
 * hostname (localhost instead of 127.0.0.1), the way github.com hands them off
 * to its asset CDN.
 */
export async function startGitHubServer ({
  tag = 'v9.8.7',
  assets = {},
  api = 'ok',
  releases = 'ok',
  throttledDownloads = 0,
  cdnRedirect = false
} = {}) {
  const requests = []
  // Authorization header per request path, in request order.
  const authorizations = []
  let throttled = 0
  let port

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    requests.push(url.pathname)
    authorizations.push({ path: url.pathname, authorization: request.headers.authorization })

    if (url.pathname === `/api/repos/${REPOSITORY}/releases/latest`) {
      if (api === 'rate-limit') {
        response.writeHead(403, rateLimitHeaders())
        response.end(RATE_LIMIT_BODY)
        return
      }
      if (api === 'error') {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ tag_name: tag }))
      return
    }

    if (url.pathname === `/gh/${REPOSITORY}/releases/latest`) {
      if (releases === 'rate-limit') {
        response.writeHead(429, { 'retry-after': '3600' })
        response.end('slow down')
        return
      }
      response.writeHead(302, { location: `/gh/${REPOSITORY}/releases/tag/${tag}` })
      response.end()
      return
    }

    if (url.pathname.startsWith('/cdn/')) {
      const asset = assets[url.pathname.slice('/cdn'.length)]
      response.writeHead(asset ? 200 : 404, { 'content-type': 'application/octet-stream' })
      response.end(asset ?? '')
      return
    }

    const asset = assets[url.pathname]
    if (asset && cdnRedirect) {
      response.writeHead(302, { location: `http://localhost:${port}/cdn${url.pathname}` })
      response.end()
      return
    }
    if (asset && throttled < throttledDownloads) {
      throttled += 1
      response.writeHead(403, { 'content-type': 'text/plain' })
      response.end('rate limited')
      return
    }
    if (asset) {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(asset.length)
      })
      response.end(asset)
      return
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"message":"Not Found"}')
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = server.address().port

  return {
    apiBaseUrl: `http://127.0.0.1:${port}/api`,
    serverBaseUrl: `http://127.0.0.1:${port}/gh`,
    requests,
    authorizations,
    async close () {
      server.close()
      await once(server, 'close')
    }
  }
}

/**
 * Builds the release archive and SHA256SUMS manifest for one release, keyed by
 * the download path the installer asks for.
 */
export function releaseAssets ({ tag, version, platform, architecture, binaryName, corruptChecksum = false }) {
  const archiveName = `tronador-cli_${version}_${platform}_${architecture}.zip`
  const checksumsName = `tronador-cli_${version}_SHA256SUMS`
  const archive = createZip({ [binaryName]: '#!/usr/bin/env bash\nprintf "tronador test binary\\n"\n' })

  const digest = corruptChecksum
    ? '0'.repeat(64)
    : createHash('sha256').update(archive).digest('hex')
  const manifest = Buffer.from(
    `${'0'.repeat(64)}  tronador-cli_${version}_other_arch.zip\n${digest}  ${archiveName}\n`
  )

  const base = `/gh/${REPOSITORY}/releases/download/${tag}`
  return {
    archiveName,
    checksumsName,
    assets: {
      [`${base}/${archiveName}`]: archive,
      [`${base}/${checksumsName}`]: manifest
    }
  }
}
