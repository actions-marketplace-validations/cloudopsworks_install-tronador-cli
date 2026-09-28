import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'

import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'

import { resolveTag } from './github.mjs'
import { resolvePlatform } from './platform.mjs'
import { RequestError, withRetry } from './retry.mjs'

export const DEFAULT_REPOSITORY = 'cloudopsworks/tronador-cli'
export const DEFAULT_API_BASE_URL = 'https://api.github.com'
export const DEFAULT_SERVER_BASE_URL = 'https://github.com'

const PROJECT_NAME = 'tronador-cli'
const TOOL_NAME = 'tronador-cli'

function validateInstallDir (installDir) {
  if (!installDir) {
    return undefined
  }
  if (/[\r\n]/.test(installDir)) {
    throw new Error('install-dir must not contain a newline')
  }
  if (!path.isAbsolute(installDir)) {
    throw new Error('install-dir must be an absolute path')
  }
  return installDir
}

async function download (url, description, token, retryOptions) {
  // Authenticated downloads let GitHub attribute the traffic to the token
  // rather than the shared runner IP. http-client drops the header when GitHub
  // redirects to its asset CDN, so the token never leaves the GitHub host.
  const auth = token ? `token ${token}` : undefined
  return withRetry(
    description,
    async () => {
      try {
        return await tc.downloadTool(url, undefined, auth)
      } catch (error) {
        if (error instanceof tc.HTTPError) {
          throw new RequestError(`HTTP ${error.httpStatusCode} for ${url}`, {
            statusCode: error.httpStatusCode,
            // A missing or inaccessible asset answers 404, so a 403 here is
            // GitHub throttling the download rather than refusing it.
            retryable: error.httpStatusCode === 403 ? true : undefined
          })
        }
        throw error
      }
    },
    retryOptions
  )
}

async function sha256 (file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function findExpectedChecksum (manifest, assetName) {
  for (const line of manifest.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match && match[2] === assetName) {
      return match[1].toLowerCase()
    }
  }
  return undefined
}

async function findBinary (directory, binaryName) {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true })
  const entry = entries.find(candidate => candidate.isFile() && candidate.name === binaryName)
  if (!entry) {
    return undefined
  }
  return path.join(entry.parentPath ?? entry.path ?? directory, entry.name)
}

/**
 * Downloads a release, verifies it against the published SHA256SUMS manifest,
 * and returns the directory the executable was cached in.
 */
async function downloadRelease ({ tag, releaseVersion, platform, architecture, binaryName, repository, serverBaseUrl, token, retryOptions, useToolCache }) {
  const archiveName = `${PROJECT_NAME}_${releaseVersion}_${platform}_${architecture}.zip`
  const checksumsName = `${PROJECT_NAME}_${releaseVersion}_SHA256SUMS`
  const baseUrl = `${serverBaseUrl}/${repository}/releases/download/${tag}`

  core.info(`Downloading Tronador ${tag} for ${platform}/${architecture}`)
  const archivePath = await download(`${baseUrl}/${archiveName}`, `Downloading ${archiveName}`, token, retryOptions)
  const checksumsPath = await download(`${baseUrl}/${checksumsName}`, `Downloading ${checksumsName}`, token, retryOptions)

  const manifest = await fs.readFile(checksumsPath, 'utf8')
  const expected = findExpectedChecksum(manifest, archiveName)
  if (!expected) {
    throw new Error(`Checksum for ${archiveName} was not found in ${checksumsName}`)
  }

  const actual = await sha256(archivePath)
  if (expected !== actual) {
    throw new Error(`Checksum verification failed for ${archiveName}`)
  }

  const extracted = await tc.extractZip(archivePath)
  const binaryPath = await findBinary(extracted, binaryName)
  if (!binaryPath) {
    throw new Error(`Unable to find ${binaryName} in ${archiveName}`)
  }
  await fs.chmod(binaryPath, 0o755)

  if (!useToolCache) {
    return path.dirname(binaryPath)
  }
  return tc.cacheFile(binaryPath, binaryName, TOOL_NAME, releaseVersion, architecture)
}

/**
 * Installs the Tronador CLI and adds it to PATH.
 */
export async function install ({
  version = 'latest',
  installDir = '',
  token = '',
  repository = DEFAULT_REPOSITORY,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  serverBaseUrl = DEFAULT_SERVER_BASE_URL,
  retryOptions
} = {}) {
  const { platform, architecture, binaryName } = resolvePlatform()
  const target = validateInstallDir(installDir.trim())
  // tool-cache needs RUNNER_TOOL_CACHE, which only a real runner sets.
  const useToolCache = Boolean(process.env.RUNNER_TOOL_CACHE)

  const tag = await resolveTag({ version, token, repository, apiBaseUrl, serverBaseUrl, retryOptions })
  const releaseVersion = tag.replace(/^v/, '')

  let sourceDir = useToolCache ? tc.find(TOOL_NAME, releaseVersion, architecture) : ''
  const cacheHit = sourceDir !== ''
  if (cacheHit) {
    // A cache hit skips every network call, which is the cheapest way to stay
    // under GitHub's rate limits when many jobs install the same release.
    core.info(`Reusing cached Tronador ${tag} from ${sourceDir}`)
  } else {
    sourceDir = await downloadRelease({
      tag,
      releaseVersion,
      platform,
      architecture,
      binaryName,
      repository,
      serverBaseUrl,
      token,
      retryOptions,
      useToolCache
    })
  }

  let directory = sourceDir
  if (target) {
    await fs.mkdir(target, { recursive: true })
    await fs.copyFile(path.join(sourceDir, binaryName), path.join(target, binaryName))
    await fs.chmod(path.join(target, binaryName), 0o755)
    directory = target
  }

  const binary = path.join(directory, binaryName)
  core.addPath(directory)
  core.info(`Installed ${binaryName} ${tag} to ${binary}`)

  return { tag, version: releaseVersion, path: binary, directory, cacheHit }
}
