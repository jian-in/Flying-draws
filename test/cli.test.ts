import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE_JS = join(ROOT, 'out', 'bridge', 'index.js')
const BRIDGE_POSIX = BRIDGE_JS.replace(/\\/g, '/')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }

function runBridge(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  return spawnSync(process.execPath, [BRIDGE_JS, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true
  })
}

before(() => {
  const tscBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(process.execPath, [tscBin, '-p', join(ROOT, 'tsconfig.bridge.json')], {
    cwd: ROOT,
    stdio: 'pipe',
    windowsHide: true
  })
})

test('CLI --version 与 -v 输出版本号且退出码为 0', () => {
  for (const flag of ['--version', '-v']) {
    const res = runBridge([flag])
    assert.equal(res.status, 0, `expected exit 0 for ${flag}, stderr: ${res.stderr}`)
    assert.equal(res.stderr, '')
    assert.equal(res.stdout.trim(), `flying-draws ${PKG.version}`)
  }
})

test('CLI --help 与 -h 输出零门槛命令说明且退出码为 0', () => {
  for (const flag of ['--help', '-h']) {
    const res = runBridge([flag])
    assert.equal(res.status, 0)
    assert.match(res.stdout, /flying-draws setup \[claude\|cursor\|codex\|antigravity\]/)
    assert.match(res.stdout, /flying-draws doctor/)
    assert.match(res.stdout, /FLYINGDRAWS_APP/)
  }
})

test('CLI setup / config 输出各主流客户端可复制配置且路径斜杠规整', () => {
  const allRes = runBridge(['setup'], { FLYINGDRAWS_APP: '' })
  assert.equal(allRes.status, 0)
  assert.ok(allRes.stdout.includes(BRIDGE_POSIX), 'setup 应填入当前 out/bridge/index.js 的正斜杠绝对路径')
  assert.match(allRes.stdout, /=== Claude Code ===/)
  assert.match(allRes.stdout, /=== Cursor ===/)
  assert.match(allRes.stdout, /=== Codex ===/)
  assert.match(allRes.stdout, /=== Antigravity ===/)

  const configAlias = runBridge(['config', 'claude'], { FLYINGDRAWS_APP: '' })
  assert.equal(configAlias.status, 0)
  assert.ok(configAlias.stdout.includes(`claude mcp add --scope user flying-draws -- node "${BRIDGE_POSIX}"`))

  const codexRes = runBridge(['setup', 'codex'], { FLYINGDRAWS_APP: '' })
  assert.equal(codexRes.status, 0)
  assert.ok(codexRes.stdout.includes(`codex mcp add flying-draws -- node "${BRIDGE_POSIX}"`))
  assert.ok(codexRes.stdout.includes('[mcp_servers.flying-draws]'))

  for (const client of ['cursor', 'antigravity'] as const) {
    const jsonRes = runBridge(['setup', client, '--json'], { FLYINGDRAWS_APP: '' })
    assert.equal(jsonRes.status, 0)
    const parsed = JSON.parse(jsonRes.stdout) as {
      mcpServers: { 'flying-draws': { command: string; args: string[] } }
    }
    assert.equal(parsed.mcpServers['flying-draws'].command, 'node')
    assert.deepEqual(parsed.mcpServers['flying-draws'].args, [BRIDGE_POSIX])
  }

  const badClient = runBridge(['setup', 'unknown-ide'])
  assert.equal(badClient.status, 1)
  assert.match(badClient.stderr, /Supported clients: claude, cursor, codex, antigravity/)
})

test('CLI doctor 在无 daemon、无 Fuxi 时仍返回退出码 0，并明确提示 10 个外部 MCP 工具 100% 可用', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'flyingdraws-cli-doctor-'))
  try {
    const fakeExe = join(tempDir, 'Custom Flying draws.exe')
    writeFileSync(fakeExe, 'stub')

    const res = runBridge(['doctor'], {
      FLYINGDRAWS_HOME: join(tempDir, 'home'),
      FLYINGDRAWS_APP: fakeExe,
      FLYINGDRAWS_FUXI_BIN: join(tempDir, 'missing-fuxi.exe')
    })
    assert.equal(res.status, 0, `doctor stderr: ${res.stderr}`)
    assert.match(res.stdout, /\[OK\]\s+Node\.js:/)
    assert.ok(res.stdout.includes(`FLYINGDRAWS_APP (${fakeExe})`), '应优先命中 FLYINGDRAWS_APP 指定的桌面端路径')
    assert.match(res.stdout, /本地画布服务: 当前未运行/)
    assert.match(res.stdout, /未安装 Fuxi 时外部 MCP 画布全部 10 个工具仍 100% 可用/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function runBridgeAsync(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(process.execPath, [BRIDGE_JS, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', rejectDone)
    child.once('close', (status) => resolveDone({ status, stdout, stderr }))
  })
}

test('CLI doctor 能识别在线的本地画布 daemon 服务', async () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'flyingdraws-cli-online-'))
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.headers['x-flyingdraws-token'] === 'test-token') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  try {
    mkdirSync(tempHome, { recursive: true })
    writeFileSync(join(tempHome, 'daemon.json'), JSON.stringify({ port: address.port, token: 'test-token' }), 'utf8')

    const res = await runBridgeAsync(['doctor'], {
      FLYINGDRAWS_HOME: tempHome,
      FLYINGDRAWS_FUXI_BIN: join(tempHome, 'no-fuxi.exe')
    })
    assert.equal(res.status, 0)
    assert.ok(res.stdout.includes(`127.0.0.1:${address.port}`), 'doctor 应报告在线 daemon 端口')
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    rmSync(tempHome, { recursive: true, force: true })
  }
})

test('CLI call：校验参数、列出工具；对在线画布调用工具时转发席位与客户端名，并提示正在用 FLYINGDRAWS_HOME 指定的画布', async () => {
  const list = runBridge(['call', '--list'])
  assert.equal(list.status, 0)
  assert.equal(list.stdout.trim().split(/\r?\n/).length, 10)
  assert.ok(list.stdout.includes('canvas_wait'))
  const unknown = runBridge(['call', 'canvas_nope'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown tool "canvas_nope"/)
  const badJson = runBridge(['call', 'canvas_read', '{oops'])
  assert.equal(badJson.status, 1)
  assert.match(badJson.stderr, /not valid JSON/)

  const tempHome = mkdtempSync(join(tmpdir(), 'flyingdraws-cli-call-'))
  const seen: Record<string, unknown>[] = []
  const server = http.createServer((req, res) => {
    if (req.headers['x-flyingdraws-token'] !== 'test-token') {
      res.writeHead(401)
      res.end('{}')
      return
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.url === '/wait' ? { status: 'waiting', waitingFor: 'user' } : { ok: true }))
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    writeFileSync(join(tempHome, 'daemon.json'), JSON.stringify({ port: address.port, token: 'test-token' }), 'utf8')
    const argsFile = join(tempHome, 'args.json')
    writeFileSync(argsFile, '\uFEFF{"board":"协作","timeout_s":1}', 'utf8')
    const res = await runBridgeAsync(['call', 'canvas_wait', `@${argsFile}`, '--as', 'Cursor', '--agent', 'cursor-cli'], { FLYINGDRAWS_HOME: tempHome })
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /has not sent anything yet/)
    assert.ok(res.stderr.includes('FLYINGDRAWS_HOME is set'), '设了 FLYINGDRAWS_HOME 时要提示连的是哪个画布')
    const wait = seen.find((b) => b.board === '协作')
    assert.ok(wait, '没有收到 /wait 请求')
    assert.equal(wait.as, 'Cursor')
    assert.equal(wait.agent, 'cursor-cli')
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    rmSync(tempHome, { recursive: true, force: true })
  }
})

test('无参数与 --mcp 启动时 stdout 严格只输出合法 MCP JSON-RPC 协议帧（零杂音）', async () => {
  const tempHome = mkdtempSync(join(tmpdir(), 'flyingdraws-mcp-stdio-'))
  try {
    for (const args of [[], ['--mcp']]) {
      const env: NodeJS.ProcessEnv = { ...process.env, FLYINGDRAWS_HOME: tempHome }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(process.execPath, [BRIDGE_JS, ...args], {
        cwd: ROOT,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      let stdout = ''
      const replyPromise = new Promise<string>((resolveReply, rejectReply) => {
        const timer = setTimeout(() => {
          child.kill()
          rejectReply(new Error(`MCP stdio initialize timed out (stdout so far: ${JSON.stringify(stdout)})`))
        }, 10_000)
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
          const newlineIdx = stdout.indexOf('\n')
          if (newlineIdx >= 0) {
            clearTimeout(timer)
            resolveReply(stdout)
          }
        })
        child.once('error', (err) => {
          clearTimeout(timer)
          rejectReply(err)
        })
      })

      const initReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cli-test', version: '0.1.0' }
        }
      })
      child.stdin.write(`${initReq}\n`)

      const captured = await replyPromise
      child.stdin.end()
      await new Promise<void>((resolveExit) => {
        const killTimer = setTimeout(() => child.kill(), 1500)
        child.once('close', () => {
          clearTimeout(killTimer)
          resolveExit()
        })
      })

      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      assert.ok(lines.length >= 1, `expected JSON-RPC output on stdout, got: ${JSON.stringify(captured)}`)
      for (const line of lines) {
        const parsed = JSON.parse(line) as {
          jsonrpc?: string
          id?: number
          result?: { serverInfo?: { name?: string; version?: string } }
        }
        assert.equal(parsed.jsonrpc, '2.0')
      }
      const first = JSON.parse(lines[0]) as { result?: { serverInfo?: { name?: string; version?: string } } }
      assert.equal(first.result?.serverInfo?.name, 'flying-draws')
      assert.equal(first.result?.serverInfo?.version, PKG.version)
    }
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})

test('package-desktop.mjs 参数校验拒绝冲突与未知参数', () => {
  const pkgScript = join(ROOT, 'scripts', 'package-desktop.mjs')
  const conflict = spawnSync(process.execPath, [pkgScript, '--without-fuxi', '--require-fuxi'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  })
  assert.notEqual(conflict.status, 0)
  assert.match(conflict.stderr, /--without-fuxi 与 --require-fuxi 不能同时指定/)

  const unknown = spawnSync(process.execPath, [pkgScript, '--unknown-flag'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  })
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /未知参数/)
})

test('fetch-fuxi.mjs 支持解压校验 SHA-256、幂等跳过、篡改拒绝与离线优雅降级', async () => {
  const fetchScript = join(ROOT, 'scripts', 'fetch-fuxi.mjs')
  const fakeBinary = Buffer.from('fake-fuxi-host-binary-payload-v1', 'utf8')
  const expectedSha = createHash('sha256').update(fakeBinary).digest('hex')
  const compressed = gzipSync(fakeBinary)
  let hits = 0

  function runScriptAsync(scriptArgs: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.HTTP_PROXY
    delete env.HTTPS_PROXY
    delete env.http_proxy
    delete env.https_proxy
    return new Promise((resolveDone, rejectDone) => {
      const child = spawn(process.execPath, [fetchScript, ...scriptArgs], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', rejectDone)
      child.once('close', (status) => resolveDone({ status, stdout, stderr }))
    })
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/fuxi.gz') {
      hits += 1
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(compressed)
      return
    }
    res.writeHead(503)
    res.end('unavailable')
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const tempDir = mkdtempSync(join(tmpdir(), 'flyingdraws-fetch-fuxi-'))

  try {
    const dest = join(tempDir, 'fuxi')
    const okRes = await runScriptAsync([
      '--require',
      '--dest',
      dest,
      '--url',
      `${baseUrl}/fuxi.gz`,
      '--expected-sha256',
      expectedSha
    ])
    assert.equal(okRes.status, 0, `fetch stderr: ${okRes.stderr}`)
    assert.equal(hits, 1)
    const binName = process.platform === 'win32' ? 'fuxi.exe' : 'fuxi'
    assert.deepEqual(readFileSync(join(dest, binName)), fakeBinary)
    assert.equal(existsSync(join(dest, 'LICENSE')), false, '内核不随包附带许可证文件')
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) as { sha256: string; profile: string }
    assert.equal(manifest.sha256, expectedSha)
    assert.equal(manifest.profile, 'release')

    // 幂等二次执行应命中本地 SHA-256 校验，不再发起 HTTP 下载
    const cachedRes = await runScriptAsync([
      '--require',
      '--dest',
      dest,
      '--url',
      `${baseUrl}/fuxi.gz`,
      '--expected-sha256',
      expectedSha
    ])
    assert.equal(cachedRes.status, 0)
    assert.equal(hits, 1)

    // 哈希不匹配必须拒绝落盘且在 --require 下返回非零退出码
    const badDest = join(tempDir, 'bad-fuxi')
    const badShaRes = await runScriptAsync([
      '--require',
      '--dest',
      badDest,
      '--url',
      `${baseUrl}/fuxi.gz`,
      '--expected-sha256',
      '0'.repeat(64)
    ])
    assert.notEqual(badShaRes.status, 0)
    assert.match(badShaRes.stderr, /SHA-256 校验失败/)
    assert.equal(existsSync(join(badDest, binName)), false)

    // 默认 postinstall 可选模式下网络失败不阻断 npm install（退出码 0）
    const offlineRes = await runScriptAsync(['--dest', badDest, '--url', `${baseUrl}/down`, '--expected-sha256', expectedSha])
    assert.equal(offlineRes.status, 0)
    assert.match(offlineRes.stderr, /外部 MCP 画布全部 10 个工具仍 100% 可用/)
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    rmSync(tempDir, { recursive: true, force: true })
  }
})
