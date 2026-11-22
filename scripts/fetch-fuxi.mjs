// 自动获取并校验预编译 Fuxi 宿主内核（免 Rust 工具链、无需公开内核源码，兼容终端代理）。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'

const execFileAsync = promisify(execFile)

const REPO = 'jian-in/Flying-draws'
const RELEASE_TAG = 'fuxi-kernel-0.4.0'
const ASSET_NAME = 'fuxi-win32-x64.exe.gz'
const DEFAULT_URL = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${ASSET_NAME}`
const SOURCE_COMMIT = '441f3bd9e6c6aa33d7696ce561d6587d09c9daad'
const DEFAULT_EXE_SHA256 = 'f20ad6a8d837ed8283940dccc6f34ceccbee26348c4a1424f9365fb0c805190b'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rawArgs = process.argv.slice(2)

function takeOption(flag) {
  const idx = rawArgs.indexOf(flag)
  if (idx < 0) return undefined
  if (idx + 1 >= rawArgs.length) throw new Error(`参数 ${flag} 缺少取值`)
  return rawArgs[idx + 1]
}

const required = rawArgs.includes('--require')
const customDest = takeOption('--dest')
const customUrl = takeOption('--url') || process.env.FLYINGDRAWS_FUXI_URL
const expectedSha256 = (takeOption('--expected-sha256') || DEFAULT_EXE_SHA256).toLowerCase()
const destination = resolve(customDest || join(root, 'resources', 'fuxi'))
const binaryName = process.platform === 'win32' ? 'fuxi.exe' : 'fuxi'
const binaryPath = join(destination, binaryName)
// 内核是维护者的私有组件，不随包附带许可证文件；以前版本留下的 LICENSE 会被清掉
const staleLicensePath = join(destination, 'LICENSE')
const manifestPath = join(destination, 'manifest.json')

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function writeMetadata(sha256) {
  await rm(staleLicensePath, { force: true })
  const manifest = {
    protocol: 1,
    sourceCommit: SOURCE_COMMIT,
    sourceDirty: false,
    profile: 'release',
    sha256
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
}

function hasProxyEnv() {
  return Boolean(
    process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.ALL_PROXY ||
      process.env.https_proxy ||
      process.env.http_proxy ||
      process.env.all_proxy
  )
}

function isLoopbackUrl(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
}

async function downloadViaCurl(targetUrl) {
  const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const tempGz = join(tmpdir(), `flyingdraws-fuxi-${process.pid}-${Date.now()}.gz`)
  try {
    await execFileAsync(
      curlBin,
      ['-fsSL', '--connect-timeout', '15', '--max-time', '90', '-A', 'flying-draws-fetch-fuxi', '-o', tempGz, '--', targetUrl],
      { windowsHide: true, timeout: 95_000 }
    )
    return await readFile(tempGz)
  } finally {
    await rm(tempGz, { force: true }).catch(() => {})
  }
}

async function downloadCompressedPayload(targetUrl) {
  const loopback = isLoopbackUrl(targetUrl)
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

  // 终端配置了 HTTP(S)_PROXY 时优先走系统自带 curl（Node 原生 fetch 默认忽略代理环境变量）
  if (!loopback && hasProxyEnv() && (!token || customUrl)) {
    try {
      return await downloadViaCurl(targetUrl)
    } catch {
      // curl 不可用或失败时继续回退到原生 fetch
    }
  }

  const timeoutMs = Number(process.env.FLYINGDRAWS_FUXI_TIMEOUT_MS || 60_000)
  let response
  try {
    response = await fetch(targetUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'flying-draws-fetch-fuxi' }
    })
  } catch (fetchErr) {
    if (!loopback) {
      try {
        return await downloadViaCurl(targetUrl)
      } catch {
        // 保留原始错误提示
      }
    }
    throw fetchErr
  }
  if (response.ok) {
    return Buffer.from(await response.arrayBuffer())
  }
  if (response.status === 404 && token && !customUrl) {
    const metaRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'flying-draws-fetch-fuxi'
      }
    })
    if (!metaRes.ok) {
      throw new Error(`HTTP ${metaRes.status} 获取 Release 元数据失败`)
    }
    const release = await metaRes.json()
    const asset = Array.isArray(release.assets) ? release.assets.find(item => item.name === ASSET_NAME) : null
    if (!asset?.url) {
      throw new Error(`Release ${RELEASE_TAG} 中未找到资产 ${ASSET_NAME}`)
    }
    const assetRes = await fetch(asset.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/octet-stream',
        'user-agent': 'flying-draws-fetch-fuxi'
      }
    })
    if (!assetRes.ok) {
      throw new Error(`HTTP ${assetRes.status} 下载 Release 资产失败`)
    }
    return Buffer.from(await assetRes.arrayBuffer())
  }
  throw new Error(`HTTP ${response.status} (${targetUrl})`)
}

async function main() {
  if (!required && process.env.FLYINGDRAWS_SKIP_FUXI_DOWNLOAD === '1') {
    console.log('[fetch-fuxi] 已通过 FLYINGDRAWS_SKIP_FUXI_DOWNLOAD=1 跳过下载')
    return
  }

  if (!customUrl && (process.platform !== 'win32' || process.arch !== 'x64')) {
    const msg = `当前预编译 Fuxi 内核仅提供 win32-x64（当前平台：${process.platform}-${process.arch}）`
    if (required) throw new Error(msg)
    console.log(`[fetch-fuxi] ${msg}；外部 MCP 画布全部 10 个工具仍 100% 可用`)
    return
  }

  if (existsSync(binaryPath)) {
    const existing = await readFile(binaryPath)
    if (sha256Hex(existing) === expectedSha256) {
      if (process.platform !== 'win32') chmodSync(binaryPath, 0o755)
      await writeMetadata(expectedSha256)
      console.log(`[fetch-fuxi] 内置 Fuxi 内核已就绪 -> ${binaryPath}`)
      return
    }
  }

  const targetUrl = customUrl || DEFAULT_URL
  console.log(`[fetch-fuxi] 正在获取预编译 Fuxi 内核 (${RELEASE_TAG})...`)
  const compressed = await downloadCompressedPayload(targetUrl)
  const decompressed = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 })
  const actualSha256 = sha256Hex(decompressed)
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Fuxi 内核 SHA-256 校验失败：期望 ${expectedSha256}，实际 ${actualSha256}`)
  }

  await mkdir(destination, { recursive: true })
  const tempPath = `${binaryPath}.tmp-${process.pid}`
  try {
    await writeFile(tempPath, decompressed)
    await rename(tempPath, binaryPath)
    if (process.platform !== 'win32') chmodSync(binaryPath, 0o755)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
  await writeMetadata(actualSha256)
  console.log(`[fetch-fuxi] 内置 Fuxi 内核安装完成 (SHA-256 已校验) -> ${binaryPath}`)
}

main().catch(error => {
  const reason = error instanceof Error ? error.message : String(error)
  if (required) {
    console.error(`[fetch-fuxi] 获取失败：${reason}`)
    process.exit(1)
  }
  console.warn(
    `[fetch-fuxi] 提示：未能自动下载预编译 Fuxi 内核（${reason}）。外部 MCP 画布全部 10 个工具仍 100% 可用；联网后可运行 npm run fetch:fuxi 重试。`
  )
})
