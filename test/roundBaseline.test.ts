import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { AgentService, planSnapshotRetention } from '../src/main/agent.ts'
import { captureRoundBaseline, collectRoundChanges, LARGE_UNTRACKED_BYTES, parseTreeDiff, pruneRoundSnapshots, roundPatch, storeKey } from '../src/main/roundBaseline.ts'
import type { AgentRun, AgentWorkItem } from '../src/shared/agent.ts'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })

async function makeRepo(): Promise<{ dir: string; repo: string; store: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fd-baseline-'))
  const repo = join(dir, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repo, '.gitignore'), 'dist/\n')
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1\n')
  await writeFile(join(repo, 'src', 'gone.ts'), 'export const gone = 1\n')
  await writeFile(join(repo, 'README.md'), '# demo\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  return { dir, repo, store: join(dir, 'store') }
}

async function countObjects(repo: string): Promise<number> {
  const root = join(repo, '.git', 'objects')
  let n = 0
  for (const sub of await readdir(root)) if (/^[0-9a-f]{2}$/.test(sub)) n += (await readdir(join(root, sub))).length
  return n
}

test('本轮基线：开始前就有的未提交改动不算，本轮的新增、修改、删除都算，被忽略的文件不算', async () => {
  const { dir, repo, store } = await makeRepo()
  try {
    // 用户开始前已经改了 README、加了一个未跟踪文件
    await writeFile(join(repo, 'README.md'), '# demo\n用户自己的改动\n')
    await writeFile(join(repo, 'notes.txt'), '草稿\n')
    const statusBefore = git(repo, 'status', '--porcelain')
    const indexBefore = await readFile(join(repo, '.git', 'index'))
    const objectsBefore = await countObjects(repo)

    const baseline = await captureRoundBaseline(join(repo, 'src'), store)
    assert.ok(baseline)
    assert.equal(baseline.preexisting, 2)
    // 拍快照不碰用户仓库：状态、索引、对象库都不变
    assert.equal(git(repo, 'status', '--porcelain'), statusBefore)
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), indexBefore)
    assert.equal(await countObjects(repo), objectsBefore)

    // 这一轮：改 a、新增 c、删掉 gone、生成被忽略的产物
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 2\nexport const a2 = 3\n')
    await writeFile(join(repo, 'src', 'c.ts'), 'export const c = 1\n')
    await unlink(join(repo, 'src', 'gone.ts'))
    await mkdir(join(repo, 'dist'))
    await writeFile(join(repo, 'dist', 'bundle.js'), 'x')

    const changes = await collectRoundChanges(baseline, store)
    assert.deepEqual(changes.files.map(f => `${f.status} ${f.path}`).sort(), ['added src/c.ts', 'deleted src/gone.ts', 'modified src/a.ts'])
    assert.equal(changes.total, 3)
    assert.equal(changes.preexisting, 2)
    const a = changes.files.find(f => f.path === 'src/a.ts')
    assert.deepEqual([a?.additions, a?.deletions], [2, 1])
    assert.equal(await countObjects(repo), objectsBefore, '算差异也不往用户仓库写对象')

    const patch = await roundPatch(changes, store, 'src/a.ts')
    assert.match(patch, /^\+export const a2 = 3$/m)
    assert.doesNotMatch(patch, /c\.ts/)
    const all = await roundPatch(changes, store)
    assert.match(all, /src\/c\.ts/)
    assert.doesNotMatch(all, /README|notes\.txt/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('本轮基线：开始前已改过的文件这一轮又改了，算进本轮，差异只含这一轮的部分', async () => {
  const { dir, repo, store } = await makeRepo()
  try {
    await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1\n// 用户的改动\n')
    const baseline = await captureRoundBaseline(repo, store)
    assert.ok(baseline)
    await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1\n// 用户的改动\n// 本轮的改动\n')
    const changes = await collectRoundChanges(baseline, store)
    assert.deepEqual(changes.files.map(f => f.path), ['src/b.ts'])
    const patch = await roundPatch(changes, store, 'src/b.ts')
    assert.match(patch, /^\+\/\/ 本轮的改动$/m)
    assert.doesNotMatch(patch, /^\+\/\/ 用户的改动$/m)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('本轮基线：目录不存在返回 null；没有改动时列表为空', async () => {
  const { dir, repo, store } = await makeRepo()
  try {
    assert.equal(await captureRoundBaseline(join(dir, 'missing'), store), null)
    const baseline = await captureRoundBaseline(repo, store)
    assert.ok(baseline)
    assert.equal(baseline.preexisting, 0)
    const changes = await collectRoundChanges(baseline, store)
    assert.equal(changes.total, 0)
    assert.equal(changes.before, changes.after)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('diff-tree 输出解析：状态、行数、二进制、带空格和中文的路径', () => {
  const nameStatus = ['M', 'src/a b.ts', 'A', 'img/图.png', 'D', 'old.ts', ''].join('\0')
  const numstat = ['3\t1\tsrc/a b.ts', '-\t-\timg/图.png', '0\t5\told.ts', ''].join('\0')
  assert.deepEqual(parseTreeDiff(nameStatus, numstat), [
    { path: 'src/a b.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'img/图.png', status: 'added', additions: null, deletions: null },
    { path: 'old.ts', status: 'deleted', additions: 0, deletions: 5 }
  ])
})

test('任务收尾等本轮差异算完：改动摘要以快照为准，工具记录说改了但实际没变就不提示缺对照图', async () => {
  const { dir, repo } = await makeRepo()
  const home = join(dir, 'home')
  try {
    await mkdir(join(home, 'agent'), { recursive: true })
    await writeFile(join(repo, 'README.md'), '# demo\n用户自己的改动\n')
    const run = (id: string, path: string) => ({
      id, mode: 'direct', status: 'running', goal: '改血条', startedAt: new Date().toISOString(), reply: '', draft: '',
      annotations: [{ imageId: 'I1', imageRef: 'src_img', pixelBbox: { x: 0, y: 0, w: 10, h: 10 }, naturalSize: { w: 100, h: 100 }, kind: 'loop', annotatorId: 'S1' }],
      sourceImageRef: 'src_img',
      tools: [{ id: 't1', name: 'edit_file', input: JSON.stringify({ path }), status: 'completed', result: 'ok' }],
      approvals: []
    })
    const item = { id: 'w', board: 'default', cwd: repo, sessionId: 's', title: 't', runs: [run('r1', 'src/claimed.ts'), run('r2', 'src/claimed.ts')] }
    await writeFile(join(home, 'agent', 'work-items.json'), JSON.stringify({ version: 1, items: [item] }))
    const service = new AgentService({ home, executable: () => '', mcpServers: {} })
    const live = service as unknown as {
      state: { busy: boolean; activeItemId: string | null; items: AgentWorkItem[] }
      beginBaseline(run: unknown, cwd: string): Promise<void>
      onEvent(e: unknown): void
    }
    live.state.activeItemId = 'w'
    const runs = live.state.items[0].runs
    const finish = async (runId: string) => {
      live.state.busy = true
      live.onEvent({ type: 'event', seq: 1, run_id: runId, req: 1, event: 'run_finished', data: { outcome: { status: 'completed' } } })
      live.onEvent({ type: 'event', seq: 2, run_id: runId, req: 1, event: 'done', data: {} })
      assert.equal(service.snapshot().busy, true, '差异算完前不应结束本轮')
      const deadline = Date.now() + 15_000
      while (service.snapshot().busy && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
      return service.snapshot().items[0].runs.find(r => r.id === runId)!
    }

    // 第 1 轮：工具记录说改了 claimed.ts，实际是用命令改了 a.ts
    runs[0].status = 'running'
    await live.beginBaseline(runs[0], repo)
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 2\n')
    const first = await finish('r1')
    assert.deepEqual(first.roundChanges?.files.map(f => f.path), ['src/a.ts'])
    assert.equal(first.roundChanges?.preexisting, 1)
    assert.deepEqual(first.changedFiles, ['a.ts'])
    assert.equal(first.status, 'unverified')
    assert.match(first.verificationWarning ?? '', /没有拍改后的页面截图/)
    assert.match(await service.roundDiff('r1', 'src/a.ts'), /^\+export const a = 2$/m)
    await assert.rejects(service.roundDiff('r1', 'README.md'), /不在本轮改动里/)

    // 第 2 轮：工具记录说改了，但文件最终没变（改完又改回去）
    runs[1].status = 'running'
    await live.beginBaseline(runs[1], repo)
    const second = await finish('r2')
    assert.equal(second.roundChanges?.total, 0)
    assert.equal(second.changedFiles, undefined)
    assert.equal(second.status, 'completed')
    assert.equal(second.verificationWarning, undefined)

    const saved = JSON.parse(await readFile(join(home, 'agent', 'work-items.json'), 'utf8')).items[0].runs
    assert.equal(saved[0].roundChanges.total, 1)
    await service.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** 快照库自己存的对象（不经 alternates），用来确认回收真的删掉了东西 */
function ownObjectExists(store: string, sha: string): boolean {
  try {
    execFileSync('git', ['--git-dir', store, 'cat-file', '-e', sha], { env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: '' }, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
async function withoutAlternates<T>(store: string, fn: () => T): Promise<T> {
  const file = join(store, 'objects', 'info', 'alternates')
  const saved = await readFile(file, 'utf8')
  await unlink(file)
  try { return fn() } finally { await writeFile(file, saved) }
}
const blobOf = (repo: string, text: string) => execFileSync('git', ['hash-object', '--stdin'], { cwd: repo, input: text, encoding: 'utf8' }).trim()

test('快照库回收：只留名单里的树，过期轮次独有的内容被删掉，用户仓库原有对象不会被复制进来', async () => {
  const { dir, repo, store } = await makeRepo()
  try {
    // 第 1 轮新建了一个只属于它的文件，第 2 轮开始前文件已被删
    const first = await captureRoundBaseline(repo, store)
    await writeFile(join(repo, 'old.txt'), 'OLD-ONLY-IN-ROUND-1\n')
    const firstChanges = await collectRoundChanges(first!, store)
    await unlink(join(repo, 'old.txt'))
    const second = await captureRoundBaseline(repo, store)
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 42\n')
    const secondChanges = await collectRoundChanges(second!, store)
    const dirOf = join(store, storeKey(repo))
    const oldBlob = blobOf(repo, 'OLD-ONLY-IN-ROUND-1\n')
    assert.equal(await withoutAlternates(dirOf, () => ownObjectExists(dirOf, oldBlob)), true)

    // 默认宽限期内：刚写的对象不动
    await pruneRoundSnapshots(store, [{ root: repo, trees: [secondChanges.before, secondChanges.after] }])
    assert.equal(await withoutAlternates(dirOf, () => ownObjectExists(dirOf, oldBlob)), true)

    const result = await pruneRoundSnapshots(store, [{ root: repo, trees: [secondChanges.before, secondChanges.after] }], { graceMs: 0 })
    assert.deepEqual(result, { removedStores: 0, collected: 1, broken: [] })
    assert.equal(await withoutAlternates(dirOf, () => ownObjectExists(dirOf, oldBlob)), false, '过期轮次独有的内容应被删掉')
    assert.equal(await withoutAlternates(dirOf, () => ownObjectExists(dirOf, firstChanges.after)), false)
    // 保留的轮次照样能看差异
    assert.match(await roundPatch(secondChanges, store, 'src/a.ts'), /^\+export const a = 42$/m)
    // 用户仓库里已有的对象（提交过的 README）不会被打包进快照库
    const readme = blobOf(repo, '# demo\n')
    assert.equal(await withoutAlternates(dirOf, () => ownObjectExists(dirOf, readme)), false)
    // 用户仓库不受影响
    assert.equal(git(repo, 'status', '--porcelain'), ' M src/a.ts\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('快照库回收：没有轮次还要的库整个删掉，刚有动静的先留着', async () => {
  const { dir, repo, store } = await makeRepo()
  try {
    await captureRoundBaseline(repo, store)
    const dirOf = join(store, storeKey(repo))
    assert.deepEqual(await pruneRoundSnapshots(store, []), { removedStores: 0, collected: 0, broken: [] })
    assert.ok(existsSync(dirOf), '刚建的库可能正在拍快照，宽限期内不删')
    assert.equal((await pruneRoundSnapshots(store, [], { graceMs: 0 })).removedStores, 1)
    assert.ok(!existsSync(dirOf))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('保留策略：每个仓库只留最近几轮的差异，进行中轮次的起点也留着', () => {
  const round = (id: string, root: string, minute: number, extra: Partial<AgentRun> = {}): AgentRun => ({
    id, mode: 'direct', status: 'completed', goal: '', startedAt: new Date(Date.UTC(2026, 10, 19, 0, minute)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 10, 19, 0, minute + 1)).toISOString(), reply: '', draft: '', tools: [], approvals: [],
    roundChanges: { root, before: `b${id}`, after: `a${id}`, files: [], total: 0, additions: 0, deletions: 0, preexisting: 0 }, ...extra
  })
  const runs = [
    round('1', 'R', 1), round('2', 'R', 2), round('3', 'R', 3), round('x', 'S', 1),
    round('p', 'R', 0, { roundChanges: { root: 'R', before: 'bp', after: 'ap', files: [], total: 0, additions: 0, deletions: 0, preexisting: 0, pruned: true } }),
    { ...round('live', 'R', 9), status: 'running', roundChanges: undefined, baseline: { root: 'R', tree: 'tlive', preexisting: 0, capturedAt: '' } } as AgentRun
  ]
  const { live, expired } = planSnapshotRetention(runs, 2)
  assert.deepEqual(expired.map(run => run.id), ['1'])
  const trees = Object.fromEntries(live.map(entry => [entry.root, entry.trees.sort()]))
  assert.deepEqual(trees, { R: ['a2', 'a3', 'b2', 'b3', 'tlive'], S: ['ax', 'bx'] })
})

test('快照不调用仓库的 clean 过滤器（如 Git LFS），超大未跟踪文件不进快照', async () => {
  const { dir, repo, store } = await makeRepo()
  try {
    const marker = join(dir, 'CLEAN_FILTER_RAN')
    await writeFile(join(repo, '.gitattributes'), '*.bin filter=fake\n')
    git(repo, 'config', 'filter.fake.clean', `node -e "require('fs').writeFileSync(process.argv[1], '')" "${marker.split(String.fromCharCode(92)).join('/')}"`)
    git(repo, 'config', 'filter.fake.required', 'true')
    const baseline = await captureRoundBaseline(repo, store)
    await writeFile(join(repo, 'asset.bin'), 'binary-ish\n')
    const big = join(repo, 'huge.dat')
    await writeFile(big, Buffer.alloc(LARGE_UNTRACKED_BYTES + 1))
    const changes = await collectRoundChanges(baseline!, store)
    assert.equal(existsSync(marker), false, '不应调用 clean 过滤器')
    // .gitattributes 在拍起点前就写好了，不算本轮；超大文件没进快照，也不在列表里
    assert.deepEqual(changes.files.map(f => f.path), ['asset.bin'])
    assert.match(await roundPatch(changes, store, 'asset.bin'), /^\+binary-ish$/m, '快照里存的是原始内容，不是过滤器的输出')
    assert.equal(changes.skippedLarge, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function listTree(root: string, base = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(`${rel}/`, ...(await listTree(root, rel)))
    else out.push(rel)
  }
  return out.sort()
}

test('普通文件夹也能拍快照：只算本轮改动，依赖和产物目录、.gitignore 里的不算，文件夹里不留任何东西', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fd-plain-'))
  const work = join(dir, 'work')
  const store = join(dir, 'store')
  try {
    await mkdir(join(work, 'src'), { recursive: true })
    await mkdir(join(work, 'node_modules', 'lib'), { recursive: true })
    await writeFile(join(work, 'src', 'a.js'), 'let a = 1\n')
    await writeFile(join(work, 'src', 'gone.js'), 'gone\n')
    await writeFile(join(work, 'node_modules', 'lib', 'index.js'), 'dep\n')
    await writeFile(join(work, '.gitignore'), 'secret.env\n')
    const before = await listTree(work)

    const baseline = await captureRoundBaseline(work, store)
    assert.ok(baseline)
    assert.equal(baseline.mode, 'plain')
    assert.equal(baseline.preexisting, 0)
    assert.deepEqual(await listTree(work), before, '拍快照不应在文件夹里留下 .git 或任何文件')

    await writeFile(join(work, 'src', 'a.js'), 'let a = 2\n')
    await writeFile(join(work, 'src', 'b.js'), 'let b = 1\n')
    await unlink(join(work, 'src', 'gone.js'))
    await writeFile(join(work, 'node_modules', 'lib', 'index.js'), 'dep v2\n')
    await mkdir(join(work, 'dist'))
    await writeFile(join(work, 'dist', 'bundle.js'), 'x')
    await writeFile(join(work, 'secret.env'), 'TOKEN=1\n')

    const changes = await collectRoundChanges(baseline, store)
    assert.equal(changes.mode, 'plain')
    assert.deepEqual(changes.files.map(f => `${f.status} ${f.path}`).sort(), ['added src/b.js', 'deleted src/gone.js', 'modified src/a.js'])
    assert.match(await roundPatch(changes, store, 'src/a.js'), /^\+let a = 2$/m)
    assert.ok(!existsSync(join(work, '.git')))

    // 第二轮：用存下来的索引当文件状态缓存，结果照样对
    const second = await captureRoundBaseline(work, store)
    assert.equal(second?.tree, changes.after)
    await writeFile(join(work, 'src', 'b.js'), 'let b = 2\n')
    const secondChanges = await collectRoundChanges(second!, store)
    assert.deepEqual(secondChanges.files.map(f => f.path), ['src/b.js'])

    // 回收：保留第二轮；文件夹删掉后整个快照库删掉
    const kept = await pruneRoundSnapshots(store, [{ root: secondChanges.root, mode: 'plain', trees: [secondChanges.before, secondChanges.after] }], { graceMs: 0 })
    assert.deepEqual(kept, { removedStores: 0, collected: 1, broken: [] })
    assert.match(await roundPatch(secondChanges, store, 'src/b.js'), /^\+let b = 2$/m)
    await rm(work, { recursive: true, force: true })
    const gone = await pruneRoundSnapshots(store, [{ root: secondChanges.root, mode: 'plain', trees: [secondChanges.before, secondChanges.after] }], { graceMs: 0 })
    assert.equal(gone.removedStores, 1)
    assert.equal(gone.broken.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('普通文件夹包住了应用数据目录时，快照不把快照库自己拍进去', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fd-plain-home-'))
  const store = join(dir, '.flyingdraws', 'agent', 'baselines')
  try {
    await writeFile(join(dir, 'note.txt'), 'hi\n')
    const baseline = await captureRoundBaseline(dir, store)
    await writeFile(join(dir, 'note.txt'), 'hi again\n')
    const changes = await collectRoundChanges(baseline!, store)
    assert.deepEqual(changes.files.map(f => f.path), ['note.txt'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
