import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

import { install } from '../src/installer.mjs'
import { resolvePlatform } from '../src/platform.mjs'
import { REPOSITORY, releaseAssets, startGitHubServer } from './helpers/server.mjs'

const { platform, architecture, binaryName } = resolvePlatform()
const NO_WAIT = { attempts: 2, wait: async () => {} }

let workspace
let originalEnv

before(async () => {
  originalEnv = { ...process.env }
})

after(() => {
  process.env = originalEnv
})

afterEach(async () => {
  // Retries ride out Windows file locks held briefly after extraction.
  await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tronador-test-'))
  process.env.RUNNER_TEMP = path.join(workspace, 'temp')
  process.env.RUNNER_TOOL_CACHE = path.join(workspace, 'tool-cache')
  process.env.GITHUB_PATH = path.join(workspace, 'github-path')
  await fs.mkdir(process.env.RUNNER_TEMP, { recursive: true })
  await fs.mkdir(process.env.RUNNER_TOOL_CACHE, { recursive: true })
  await fs.writeFile(process.env.GITHUB_PATH, '')
})

async function serve (options = {}) {
  const tag = options.tag ?? 'v9.8.7'
  const { assets } = releaseAssets({
    tag,
    version: tag.replace(/^v/, ''),
    platform,
    architecture,
    binaryName,
    corruptChecksum: options.corruptChecksum
  })
  return startGitHubServer({ ...options, tag, assets })
}

function downloadAuthorizations (server) {
  return server.authorizations.filter(({ path }) => path.includes('/releases/download/'))
}

async function installWith (server, overrides = {}) {
  return install({
    repository: REPOSITORY,
    apiBaseUrl: server.apiBaseUrl,
    serverBaseUrl: server.serverBaseUrl,
    retryOptions: NO_WAIT,
    ...overrides
  })
}

describe('install', () => {
  it('resolves the latest release, verifies it, and reports the install path', async () => {
    const server = await serve()
    try {
      const result = await installWith(server, { version: 'latest', token: 'test-token' })

      assert.equal(result.tag, 'v9.8.7')
      assert.equal(result.cacheHit, false)
      assert.equal(path.basename(result.path), binaryName)
      await assert.doesNotReject(fs.access(result.path))

      const githubPath = await fs.readFile(process.env.GITHUB_PATH, 'utf8')
      assert.ok(githubPath.includes(result.directory))
      assert.ok(server.requests.includes(`/api/repos/${REPOSITORY}/releases/latest`))
      assert.ok(
        server.requests.some(request =>
          request.endsWith(`/releases/download/v9.8.7/tronador-cli_9.8.7_${platform}_${architecture}.zip`)
        )
      )
    } finally {
      await server.close()
    }
  })

  it('normalizes a pinned version without spending any API quota', async () => {
    const server = await serve({ tag: 'v1.2.3' })
    try {
      const result = await installWith(server, { version: '1.2.3', token: 'test-token' })

      assert.equal(result.tag, 'v1.2.3')
      assert.ok(!server.requests.some(request => request.startsWith('/api/')))
      assert.ok(!server.requests.some(request => request.endsWith('/releases/latest')))
    } finally {
      await server.close()
    }
  })

  it('accepts a v-prefixed version', async () => {
    const server = await serve({ tag: 'v2.3.4' })
    try {
      const result = await installWith(server, { version: 'v2.3.4' })
      assert.equal(result.tag, 'v2.3.4')
    } finally {
      await server.close()
    }
  })

  it('installs into an explicit install-dir and adds it to PATH', async () => {
    const server = await serve()
    const installDir = path.join(workspace, 'explicit', 'bin')
    try {
      const result = await installWith(server, { version: 'latest', installDir, token: 'test-token' })

      assert.equal(result.directory, installDir)
      assert.equal(result.path, path.join(installDir, binaryName))
      await assert.doesNotReject(fs.access(result.path))
    } finally {
      await server.close()
    }
  })

  it('falls back to the release redirect when the API is rate limited', async () => {
    const server = await serve({ api: 'rate-limit' })
    try {
      const result = await installWith(server, { version: 'latest', token: 'test-token' })

      assert.equal(result.tag, 'v9.8.7')
      assert.ok(server.requests.includes(`/api/repos/${REPOSITORY}/releases/latest`))
      assert.ok(server.requests.includes(`/gh/${REPOSITORY}/releases/latest`))
    } finally {
      await server.close()
    }
  })

  it('prefers the redirect and never calls the API when no token is supplied', async () => {
    const server = await serve()
    try {
      const result = await installWith(server, { version: 'latest', token: '' })

      assert.equal(result.tag, 'v9.8.7')
      assert.ok(!server.requests.some(request => request.startsWith('/api/')))
    } finally {
      await server.close()
    }
  })

  it('recommends a token when every resolution path is rate limited', async () => {
    const server = await serve({ api: 'rate-limit', releases: 'rate-limit' })
    try {
      await assert.rejects(
        installWith(server, { version: 'latest', token: '' }),
        /rate limited this runner.*token/s
      )
    } finally {
      await server.close()
    }
  })

  it('serves a second install of the same release from the tool cache', async () => {
    const server = await serve()
    try {
      await installWith(server, { version: '9.8.7' })
      const downloads = server.requests.length

      const result = await installWith(server, { version: '9.8.7' })

      assert.equal(result.cacheHit, true)
      assert.equal(server.requests.length, downloads, 'a cache hit must not hit the network')
      await assert.doesNotReject(fs.access(result.path))
    } finally {
      await server.close()
    }
  })

  it('rejects an unsafe version before any request is made', async () => {
    const server = await serve()
    try {
      await assert.rejects(installWith(server, { version: '../malicious' }), /Version must be/)
      assert.deepEqual(server.requests, [])
    } finally {
      await server.close()
    }
  })

  it('rejects a relative install-dir before any request is made', async () => {
    const server = await serve()
    try {
      await assert.rejects(
        installWith(server, { version: 'latest', installDir: 'relative/bin' }),
        /install-dir must be an absolute path/
      )
      assert.deepEqual(server.requests, [])
    } finally {
      await server.close()
    }
  })

  it('rejects a mismatched checksum and installs nothing', async () => {
    const server = await serve({ tag: 'v1.2.3', corruptChecksum: true })
    const installDir = path.join(workspace, 'explicit', 'bin')
    try {
      await assert.rejects(
        installWith(server, { version: '1.2.3', installDir }),
        /Checksum verification failed/
      )
      await assert.rejects(fs.access(path.join(installDir, binaryName)))
    } finally {
      await server.close()
    }
  })

  it('authenticates the API lookup and both release downloads with the token', async () => {
    const server = await serve()
    try {
      await installWith(server, { version: 'latest', token: 'test-token' })

      const api = server.authorizations.find(({ path }) => path.startsWith('/api/'))
      assert.equal(api.authorization, 'Bearer test-token')

      const downloads = downloadAuthorizations(server)
      assert.equal(downloads.length, 2, 'expected the archive and the checksum manifest')
      for (const download of downloads) {
        assert.equal(download.authorization, 'token test-token', `${download.path} was not authenticated`)
      }
    } finally {
      await server.close()
    }
  })

  it('authenticates downloads of a pinned version with the token', async () => {
    const server = await serve({ tag: 'v1.2.3' })
    try {
      await installWith(server, { version: '1.2.3', token: 'test-token' })

      const downloads = downloadAuthorizations(server)
      assert.equal(downloads.length, 2)
      assert.ok(downloads.every(({ authorization }) => authorization === 'token test-token'))
    } finally {
      await server.close()
    }
  })

  it('downloads anonymously when no token is supplied', async () => {
    const server = await serve({ tag: 'v1.2.3' })
    try {
      await installWith(server, { version: '1.2.3', token: '' })

      assert.ok(server.authorizations.length > 0)
      assert.ok(server.authorizations.every(({ authorization }) => authorization === undefined))
    } finally {
      await server.close()
    }
  })

  it('retries a throttled download', async () => {
    const server = await serve({ tag: 'v1.2.3', throttledDownloads: 1 })
    try {
      const result = await installWith(server, { version: '1.2.3', token: 'test-token' })

      assert.equal(result.tag, 'v1.2.3')
      const downloads = downloadAuthorizations(server)
      assert.equal(downloads.length, 3, 'the throttled archive download is retried once')
      assert.ok(downloads.every(({ authorization }) => authorization === 'token test-token'))
    } finally {
      await server.close()
    }
  })

  it('drops the token when a download redirects to another host', async () => {
    const server = await serve({ tag: 'v1.2.3', cdnRedirect: true })
    try {
      await installWith(server, { version: '1.2.3', token: 'test-token' })

      const github = downloadAuthorizations(server).filter(({ path }) => path.startsWith('/gh/'))
      const cdn = downloadAuthorizations(server).filter(({ path }) => path.startsWith('/cdn/'))
      assert.equal(github.length, 2)
      assert.equal(cdn.length, 2)
      assert.ok(github.every(({ authorization }) => authorization === 'token test-token'))
      assert.ok(cdn.every(({ authorization }) => authorization === undefined), 'the token leaked to the CDN host')
    } finally {
      await server.close()
    }
  })

  it('fails clearly when the release does not exist', async () => {
    const server = await serve({ tag: 'v1.2.3' })
    try {
      await assert.rejects(installWith(server, { version: '4.5.6' }), /HTTP 404/)
    } finally {
      await server.close()
    }
  })
})
