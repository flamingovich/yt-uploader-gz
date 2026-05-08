import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function resolveAppIconPath(): string | undefined {
  const candidates = [
    join(process.cwd(), 'yt-uploader-logo.png'),
    join(app.getAppPath(), 'yt-uploader-logo.png'),
    join(process.resourcesPath, 'yt-uploader-logo.png'),
    join(process.resourcesPath, 'app.asar.unpacked', 'yt-uploader-logo.png')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return undefined
}
