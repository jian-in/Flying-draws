// 每轮任务开始前给工作区拍一张快照，结束后再拍一张，两张一比就是这一轮真正改了什么。
// 工作区本来就有一堆没提交的改动时，git diff 分不出哪些是这一轮的；快照把它们算进起点，就排除掉了。
//
// 快照库是 Flying draws 在本机数据目录（~/.flyingdraws/agent/baselines）里为每个工作目录建的裸仓库，
// 不往用户的项目里写任何东西：
// - 工作目录在 git 仓库里（git 模式）：临时索引从用户索引复制（借它的文件状态缓存，加快 add），
//   对象写进快照库，仓库原有对象经 alternates 只读引用。用户的索引、引用、工作区和 .git 都不变。
// - 普通文件夹（plain 模式）：快照库自己当 git 目录、那个文件夹当工作区来拍。默认排除依赖、构建产物、
//   虚拟环境之类的目录，文件夹里的 .gitignore 照样生效；文件太多或太大的文件夹不拍。
//
// 快照库会随改动内容变大，所以有回收：调用方给出还要看差异的那些树，
// pruneRoundSnapshots 把它们写成引用，再让 git gc 打包、删掉其余对象；没有任何一轮还要的快照库整个删掉。
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { RoundBaseline, RoundChanges, RoundFileChange, SnapshotMode } from '../shared/agent.ts'

const LIST_LIMIT = 200
const PATCH_LIMIT = 300 * 1024
/** 超过这个大小的未跟踪文件不进快照（多半是没忽略的产物、数据、视频），免得快照又慢又大 */
export const LARGE_UNTRACKED_BYTES = 50 * 1024 * 1024
/** 普通文件夹第一次拍快照时，文件数和总大小（不含超大文件）的上限：超过多半是选了整个盘或用户目录 */
export const PLAIN_MAX_FILES = 20_000
export const PLAIN_MAX_BYTES = 1024 * 1024 * 1024
/** 普通文件夹默认不进快照的目录和文件（文件夹自己的 .gitignore 另外生效） */
export const PLAIN_DEFAULT_EXCLUDES = [
  'node_modules/', 'bower_components/', 'jspm_packages/', '.pnpm-store/', '.yarn/cache/',
  'dist/', 'build/', 'out/', '.next/', '.nuxt/', '.svelte-kit/', '.turbo/', '.parcel-cache/', '.cache/', '.vite/', 'coverage/',
  'target/', 'bin/Debug/', 'bin/Release/', 'obj/',
  '.venv/', 'venv/', 'env/', '__pycache__/', '*.pyc', '.pytest_cache/', '.mypy_cache/', '.tox/',
  '.gradle/', '.idea/', '.vs/', '.rivet/',
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '*.tmp', '*.log'
]
/** 回收时不动这段时间内新写的对象和新建的快照库：可能正有一轮在拍快照 */
const GRACE_MS = 2 * 60 * 60 * 1000

/** 只留和 git 位置无关的环境变量，免得外面设的 GIT_DIR、GIT_INDEX_FILE 把快照带到别处。 */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES)$/i.test(key)) delete env[key]
  }
  return env
}

function git(args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}, timeout = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: { ...baseEnv(), ...extra }, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const detail = (error as { killed?: boolean }).killed ? '超时' : String(stderr || '').trim().split('\n').filter(Boolean).at(-1)
        reject(new Error(detail || error.message))
      } else resolve(stdout)
    })
  })
}

/** 快照库的目录名：按工作目录路径分开，同一目录多轮共用，没变的文件不会重复存。 */
export function storeKey(root: string): string {
  const key = process.platform === 'win32' ? root.replace(/\\/g, '/').toLowerCase() : root
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** 一次快照要用的位置和环境：快照库目录、工作区根目录、git 命令的环境变量。 */
interface Target {
  mode: SnapshotMode
  root: string
  store: string
  /** 不含索引的环境：git 模式指向快照库对象 + 用户仓库对象，plain 模式把快照库当 git 目录 */
  env: NodeJS.ProcessEnv
  /** 每条命令前加的 -c 选项 */
  config: string[]
  /** 复制来当临时索引的索引文件（借文件状态缓存） */
  sourceIndex: string
  /** 拍完把临时索引存回这里，下次拍更快（只有 plain 模式，用户的索引绝不回写） */
  saveIndex?: string
  /** 用户仓库的对象目录（git 模式） */
  alternates?: string
}

async function gitRepo(cwd: string): Promise<{ root: string; objects: string; index: string } | null> {
  let out: string
  try {
    out = await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-path', 'index'], cwd)
  } catch {
    return null
  }
  const [root, common, index] = out.split(/\r?\n/).map(line => line.trim())
  if (!root || !common || !index) return null
  return { root, objects: join(common, 'objects'), index }
}

/** 建好快照库（裸仓库）。git 模式写 alternates；plain 模式写默认排除，并排除快照库自己（工作区包住数据目录时）。 */
async function ensureStore(store: string, mode: SnapshotMode, root: string, alternates?: string): Promise<void> {
  if (!existsSync(join(store, 'HEAD'))) {
    await mkdir(store, { recursive: true })
    await git(['init', '--bare', '-q', '--template=', store], store)
  }
  await mkdir(join(store, 'objects', 'info'), { recursive: true })
  if (alternates) await writeFile(join(store, 'objects', 'info', 'alternates'), `${alternates}\n`)
  if (mode === 'plain') {
    const excludes = [...PLAIN_DEFAULT_EXCLUDES]
    const inside = relative(root, store)
    if (inside && !inside.startsWith('..') && !isAbsolute(inside)) {
      // 快照库在工作区里面：排除到数据目录那一层，免得拍快照把快照库自己也拍进去
      const parts = inside.split(/[\\/]+/)
      excludes.push(`/${parts.slice(0, Math.max(1, parts.length - 2)).join('/')}/`)
    }
    await mkdir(join(store, 'info'), { recursive: true })
    await writeFile(join(store, 'info', 'exclude'), `${excludes.join('\n')}\n`)
  }
}

async function resolveTarget(storeRoot: string, root: string, mode?: SnapshotMode): Promise<Target | null> {
  if (mode !== 'plain') {
    const repo = await gitRepo(root)
    if (repo) {
      const store = join(storeRoot, storeKey(repo.root))
      return {
        mode: 'git', root: repo.root, store, alternates: repo.objects, sourceIndex: repo.index, config: [],
        env: { GIT_OBJECT_DIRECTORY: join(store, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: repo.objects }
      }
    }
    if (mode === 'git') return null
  }
  const dir = await realpath(root).catch(() => null)
  if (!dir || !(await stat(dir).then(s => s.isDirectory(), () => false))) return null
  const store = join(storeRoot, storeKey(dir))
  return {
    mode: 'plain', root: dir, store, sourceIndex: join(store, 'index'), saveIndex: join(store, 'index'),
    config: ['-c', 'core.bare=false'],
    env: { GIT_DIR: store, GIT_WORK_TREE: dir }
  }
}

/**
 * 关掉仓库配置的所有 clean 过滤器（Git LFS 等）。不关的话 add 会调 LFS，
 * 它会把文件内容复制进用户仓库的 .git/lfs/objects；关掉后快照里存原始内容，只进快照库。
 */
async function filterOverrides(target: Target): Promise<string[]> {
  let out = ''
  try { out = await git([...target.config, 'config', '-z', '--get-regexp', '^filter\\.'], target.root, target.env) } catch { return [] } // 没配任何过滤器时退出码非零
  const names = new Set<string>()
  for (const entry of out.split('\0')) {
    const key = entry.split('\n')[0]
    const match = /^filter\.(.+)\.[^.]+$/i.exec(key)
    if (match) names.add(match[1])
  }
  return [...names].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`])
}

/** 还没进索引的文件：挑出超大的给 add 当排除项；plain 模式顺便检查文件夹是不是太大。 */
async function scanUntracked(target: Target, env: NodeJS.ProcessEnv, config: string[]): Promise<string[]> {
  // 普通文件夹可能是整个盘，列文件也给个时限
  const timeout = target.mode === 'plain' ? 60_000 : 300_000
  const listed = await git([...config, 'ls-files', '-o', '--exclude-standard', '-z', '--', ':/'], target.root, env, timeout)
    .catch((error: Error) => { throw target.mode === 'plain' ? new Error(`列文件${error.message === '超时' ? '超时' : '失败'}，文件夹可能太大`) : error })
  const paths = listed.split('\0').filter(Boolean)
  if (target.mode === 'plain' && paths.length > PLAIN_MAX_FILES) throw new Error(`文件夹里有 ${paths.length} 个文件，超过 ${PLAIN_MAX_FILES} 个的上限`)
  const large: string[] = []
  let bytes = 0
  for (let i = 0; i < paths.length; i += 64) {
    const sizes = await Promise.all(paths.slice(i, i + 64).map(path => stat(join(target.root, path)).then(s => s.size, () => 0)))
    sizes.forEach((size, k) => {
      if (size > LARGE_UNTRACKED_BYTES) large.push(paths[i + k])
      else bytes += size
    })
  }
  if (target.mode === 'plain' && bytes > PLAIN_MAX_BYTES) throw new Error(`文件夹里的文件合计超过 ${Math.round(PLAIN_MAX_BYTES / 1024 / 1024 / 1024)} GB`)
  return large
}

/** 把工作区当前的样子（含未跟踪、不含被忽略和超大未跟踪的文件）写成一棵树。 */
async function snapshotTree(target: Target): Promise<{ tree: string; skipped: number }> {
  await ensureStore(target.store, target.mode, target.root, target.alternates)
  const index = join(target.store, `index-${randomUUID()}`)
  const pathspec = `${index}.pathspec`
  try {
    await copyFile(target.sourceIndex, index).catch(() => undefined) // 还没有索引时从空索引开始
    const env = { ...target.env, GIT_INDEX_FILE: index }
    // 每条命令都要带上：write-tree 也会把「时间戳太近、可能脏」的索引项重新过一遍 clean 过滤器
    const config = [...target.config, ...(await filterOverrides(target)), '-c', 'core.fsmonitor=false', '-c', 'core.safecrlf=false']
    const skipped = await scanUntracked(target, env, config)
    await writeFile(pathspec, [':/', ...skipped.map(path => `:(top,literal,exclude)${path}`), ''].join('\0'))
    // --ignore-errors：被别的程序占着读不了的文件跳过。这时 add 仍返回非零，但能读的已经进了索引，
    // write-tree 能成功就用这张快照；write-tree 也失败才算没拍成。
    const added = await git([...config, 'add', '-A', '--ignore-errors', `--pathspec-from-file=${pathspec}`, '--pathspec-file-nul'], target.root, env)
      .then(() => null, (error: Error) => error)
    let tree: string
    try {
      tree = (await git([...config, 'write-tree'], target.root, env)).trim()
    } catch (error) {
      throw added ?? error
    }
    if (target.saveIndex) await copyFile(index, target.saveIndex).catch(() => undefined)
    return { tree, skipped: skipped.length }
  } finally {
    for (const file of [index, `${index}.lock`, pathspec]) await rm(file, { force: true }).catch(() => undefined)
  }
}

/**
 * 本轮开始前拍快照。git 仓库里按 git 模式拍，否则把目录当普通文件夹拍；目录不存在返回 null。
 * preexisting：开始前相对 HEAD 已经有改动的文件数（只有 git 模式），只用来告诉用户「这些没算在本轮里」。
 */
export async function captureRoundBaseline(cwd: string, storeRoot: string): Promise<RoundBaseline | null> {
  const target = await resolveTarget(storeRoot, cwd)
  if (!target) return null
  const { tree, skipped } = await snapshotTree(target)
  let preexisting = 0
  if (target.mode === 'git') {
    try {
      const head = (await git(['rev-parse', '--verify', '-q', 'HEAD^{tree}'], target.root)).trim()
      if (head && head !== tree) {
        const names = await git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', head, tree], target.root, target.env)
        preexisting = names.split('\0').filter(Boolean).length
      }
    } catch { /* 还没有提交 */ }
  }
  return {
    root: target.root, tree, preexisting, ...(target.mode === 'plain' ? { mode: 'plain' as const } : {}),
    ...(skipped ? { skippedLarge: skipped } : {}), capturedAt: new Date().toISOString()
  }
}

/** 解析 `diff-tree -z --name-status` 和 `--numstat` 的输出，合成按路径的改动列表。 */
export function parseTreeDiff(nameStatus: string, numstat: string): RoundFileChange[] {
  const counts = new Map<string, { additions: number | null; deletions: number | null }>()
  for (const entry of numstat.split('\0')) {
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(entry)
    if (!match) continue
    counts.set(match[3], { additions: match[1] === '-' ? null : Number(match[1]), deletions: match[2] === '-' ? null : Number(match[2]) })
  }
  const parts = nameStatus.split('\0')
  const files: RoundFileChange[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i].trim().charAt(0)
    const path = parts[i + 1]
    if (!code || !path) continue
    const status: RoundFileChange['status'] = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
    const count = counts.get(path)
    files.push({ path, status, additions: count?.additions ?? null, deletions: count?.deletions ?? null })
  }
  return files
}

const modeOf = (value: { mode?: SnapshotMode }): SnapshotMode => value.mode ?? 'git'
const goneMessage = (mode: SnapshotMode) => (mode === 'git' ? '工作目录已不在 git 仓库里' : '工作目录已不存在')

/** 本轮结束时再拍一张，和开始前的比，得到只属于这一轮的改动。 */
export async function collectRoundChanges(baseline: RoundBaseline, storeRoot: string): Promise<RoundChanges> {
  const target = await resolveTarget(storeRoot, baseline.root, modeOf(baseline))
  if (!target) throw new Error(goneMessage(modeOf(baseline)))
  const { tree: after, skipped } = await snapshotTree(target)
  const [nameStatus, numstat] = after === baseline.tree
    ? ['', '']
    : await Promise.all([
        git([...target.config, 'diff-tree', '-r', '-z', '--no-renames', '--name-status', baseline.tree, after], target.root, target.env),
        git([...target.config, 'diff-tree', '-r', '-z', '--no-renames', '--numstat', baseline.tree, after], target.root, target.env)
      ])
  const all = parseTreeDiff(nameStatus, numstat)
  const skippedLarge = Math.max(baseline.skippedLarge ?? 0, skipped)
  return {
    root: target.root,
    ...(target.mode === 'plain' ? { mode: 'plain' as const } : {}),
    before: baseline.tree,
    after,
    files: all.slice(0, LIST_LIMIT),
    total: all.length,
    additions: all.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: all.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    preexisting: baseline.preexisting,
    ...(skippedLarge ? { skippedLarge } : {})
  }
}

/** 本轮某个文件（不给就是全部）的统一差异文本，过长截断。 */
export async function roundPatch(changes: Pick<RoundChanges, 'root' | 'before' | 'after' | 'mode'>, storeRoot: string, path?: string): Promise<string> {
  const target = await resolveTarget(storeRoot, changes.root, modeOf(changes))
  if (!target) throw new Error(`${goneMessage(modeOf(changes))}，看不了这一轮的差异`)
  const args = [...target.config, 'diff-tree', '-p', '-r', '--no-renames', '--no-color', '--no-ext-diff', changes.before, changes.after]
  if (path) args.push('--', `:(literal)${path}`)
  const text = await git(args, target.root, target.env)
  return text.length > PATCH_LIMIT ? `${text.slice(0, PATCH_LIMIT)}\n…（差异过长，只显示前 ${Math.round(PATCH_LIMIT / 1024)} KB）` : text
}

export interface LiveSnapshots {
  /** 工作区根目录 */
  root: string
  mode?: SnapshotMode
  /** 还要能看差异的树（保留的轮次的 before / after，进行中轮次的起点） */
  trees: string[]
}
export interface PruneResult {
  /** 整个删掉的快照库数 */
  removedStores: number
  /** 跑过 gc 的快照库数 */
  collected: number
  /** 对象已经不全、看不了差异的树（例如用户仓库 gc 掉了它引用的旧对象），调用方应把对应轮次标成已清理 */
  broken: string[]
}

const alternatesEnv = (target: Target): NodeJS.ProcessEnv => ({ GIT_ALTERNATE_OBJECT_DIRECTORIES: target.alternates ?? '' })

/** 树引用的对象是否都还在（自己库里或用户仓库里）。 */
async function treeComplete(target: Target, tree: string): Promise<boolean> {
  try {
    await git(['--git-dir', target.store, 'rev-list', '--objects', '--quiet', tree], target.store, alternatesEnv(target))
    return true
  } catch {
    return false
  }
}

async function collectStore(target: Target, trees: string[], graceMs: number): Promise<void> {
  const dir = target.store
  // 引用就是保留名单：先清掉上次的，再给每棵要留的树写一个。
  // plain 模式的快照库还有自己的索引（下次拍快照的文件状态缓存），gc 会把它引用的对象一并留着。
  await rm(join(dir, 'refs', 'keep'), { recursive: true, force: true })
  await rm(join(dir, 'packed-refs'), { force: true })
  await mkdir(join(dir, 'refs', 'keep'), { recursive: true })
  for (const tree of trees) await writeFile(join(dir, 'refs', 'keep', tree), `${tree}\n`)
  const prune = graceMs > 0 ? `${Math.max(1, Math.round(graceMs / 60_000))}.minutes.ago` : 'now'
  await git(['--git-dir', dir, '-c', 'gc.auto=0', '-c', 'core.logAllRefUpdates=false', 'gc', '--quiet', `--prune=${prune}`], dir, alternatesEnv(target))
}

/**
 * 回收快照库：live 之外的对象交给 git gc 删掉（新写的对象有宽限期），
 * 没有任何一轮还要、或者工作目录已经不在了、也不是刚有动静的快照库整个删掉。
 */
export async function pruneRoundSnapshots(
  storeRoot: string,
  live: readonly LiveSnapshots[],
  { now = Date.now(), graceMs = GRACE_MS }: { now?: number; graceMs?: number } = {}
): Promise<PruneResult> {
  const result: PruneResult = { removedStores: 0, collected: 0, broken: [] }
  const keep = new Map<string, { root: string; mode: SnapshotMode; trees: Set<string> }>()
  for (const entry of live) {
    const key = storeKey(entry.root)
    const slot = keep.get(key) ?? { root: entry.root, mode: entry.mode ?? 'git', trees: new Set<string>() }
    for (const tree of entry.trees) if (/^[0-9a-f]{40,64}$/.test(tree)) slot.trees.add(tree)
    keep.set(key, slot)
  }
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(storeRoot, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{16}$/.test(entry.name)) continue
    const dir = join(storeRoot, entry.name)
    const slot = keep.get(entry.name)
    const target = slot?.trees.size ? await resolveTarget(storeRoot, slot.root, slot.mode) : null
    if (!slot?.trees.size || !target || target.store !== dir) {
      // 没有轮次还要它，或者工作目录已经不在了。刚有动静的先不动：可能正有一轮在拍快照
      const modified = await stat(dir).then(s => s.mtimeMs, () => now)
      if (now - modified < graceMs) continue
      await rm(dir, { recursive: true, force: true })
      result.removedStores++
      if (slot) result.broken.push(...slot.trees)
      continue
    }
    await ensureStore(target.store, target.mode, target.root, target.alternates) // 旧版只有 objects 目录
    let trees = [...slot.trees]
    try {
      await collectStore(target, trees, graceMs)
    } catch {
      // 多半是某棵树引用的对象已经没了（用户仓库 gc 过）：去掉这些树再来一次
      const complete: string[] = []
      for (const tree of trees) {
        if (await treeComplete(target, tree)) complete.push(tree)
        else result.broken.push(tree)
      }
      trees = complete
      await collectStore(target, trees, graceMs)
    }
    result.collected++
  }
  return result
}
