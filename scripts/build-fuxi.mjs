import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const sourceIndex = args.indexOf('--source')
const source = resolve(sourceIndex >= 0 ? args[sourceIndex + 1] : process.env.FLYINGDRAWS_FUXI_SOURCE || join(root, '..', 'fuxi-code'))
if (!existsSync(join(source, 'Cargo.toml'))) throw new Error('找不到 Fuxi 源码，请用 --source PATH 或 FLYINGDRAWS_FUXI_SOURCE 指定')
const debug = args.includes('--debug')
const target = join(source, 'target', 'flyingdraws')
const command = ['build', '--locked', '-p', 'fuxi-main', '--target-dir', target]
if (!debug) command.push('--release')
if (!args.includes('--online')) command.push('--offline')
const built = spawnSync('cargo', command, { cwd: source, stdio: 'inherit', windowsHide: true })
if (built.error) throw built.error
if (built.status !== 0) process.exit(built.status ?? 1)
const filename = process.platform === 'win32' ? 'fuxi.exe' : 'fuxi'
const binary = join(target, debug ? 'debug' : 'release', filename)
const destination = join(root, 'resources', 'fuxi')
await mkdir(destination, { recursive: true })
await copyFile(binary, join(destination, filename))
await copyFile(join(source, 'LICENSE'), join(destination, 'LICENSE'))
const commit = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() || null
const dirty = Boolean(spawnSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout?.trim())
await writeFile(join(destination, 'manifest.json'), JSON.stringify({ protocol: 1, sourceCommit: commit, sourceDirty: dirty, profile: debug ? 'debug' : 'release', sha256: createHash('sha256').update(await readFile(binary)).digest('hex') }, null, 2))
console.log(`Fuxi 内核已放入 ${destination}`)
