import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { NtExecutable, NtExecutableResource, Resource } from 'resedit'
import { setExecutableIcon } from './executable-icon.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'flying-draws-exe-icon-'))
try {
  const target = join(temp, 'Flying draws.exe')
  const dir = join(root, 'resources', 'icon')
  await copyFile(join(root, 'node_modules/electron/dist/electron.exe'), target)
  await setExecutableIcon(target, join(dir, 'icon.ico'))
  const exe = NtExecutable.from(await readFile(target))
  const { entries } = NtExecutableResource.from(exe)
  const groups = Resource.IconGroupEntry.fromEntries(entries)
  assert.ok(groups.length > 0)
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  for (const group of groups) {
    const items = group.getIconItemsFromEntries(entries)
    assert.deepEqual(group.icons.map(item => item.width || 256), sizes)
    for (const [i, item] of items.entries()) {
      assert.deepEqual(Buffer.from(item.bin), await readFile(join(dir, 'icon-' + sizes[i] + '.png')))
    }
    console.log('Verified PE icon group %s (language %s): %s px, all embedded PNGs match', group.id, group.lang, sizes.join('/'))
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
