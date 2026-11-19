// 跑除 roundBaseline、cli 以外的全部单元测试。test/ 里新增的 *.test.ts 会自动纳入。
import { readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skip = new Set(['roundBaseline.test.ts', 'cli.test.ts'])
const files = readdirSync(join(root, 'test'))
  .filter(name => name.endsWith('.test.ts') && !skip.has(name))
  .sort()
  .map(name => join(root, 'test', name))

if (files.length === 0) {
  console.error('test:fast：没有可运行的测试文件')
  process.exit(1)
}

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root })
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1))
