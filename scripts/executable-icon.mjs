import { readFile, writeFile } from 'node:fs/promises'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'

// 改写图标会改动 exe 本身；要分发签名版的话，签名必须放在这一步之后。
export async function setExecutableIcon(executablePath, iconPath) {
  const exe = NtExecutable.from(await readFile(executablePath), { ignoreCert: true })
  const resources = NtExecutableResource.from(exe)
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
  if (!groups.length) throw new Error('Electron executable has no icon group')
  const icons = Data.IconFile.from(await readFile(iconPath)).icons.map(entry => entry.data)
  for (const { id, lang } of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, id, lang, icons)
  }
  resources.outputResource(exe)
  await writeFile(executablePath, Buffer.from(exe.generate()))
}
