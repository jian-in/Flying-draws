// appRoot：开发时是项目目录，打包后是 resources/app。托盘按 1×、1.5×、2× 取对应尺寸的 PNG，等审批时换成带红点的版本。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function trayRepresentations(appRoot: string, alert = false) {
  return [16, 24, 32].map(size => ({
    scaleFactor: size / 16,
    buffer: readFileSync(join(appRoot, 'resources', 'icon', `${alert ? 'alert' : 'icon'}-${size}.png`))
  }))
}
