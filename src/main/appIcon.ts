import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Каталог собранного main (out/main) — на два уровня вверх корень репозитория с yt-uploader-logo.png */
const mainBundleDir = dirname(fileURLToPath(import.meta.url))

export function resolveAppIconPath(): string | undefined {
  const candidates = [
    join(process.cwd(), 'yt-uploader-logo.png'),
    join(mainBundleDir, '../../yt-uploader-logo.png'),
    join(app.getAppPath(), 'yt-uploader-logo.png'),
    join(process.resourcesPath, 'yt-uploader-logo.png'),
    join(process.resourcesPath, 'app.asar.unpacked', 'yt-uploader-logo.png')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return undefined
}
