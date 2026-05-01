import { execFile } from 'node:child_process'
import { resolve } from 'node:path'

/** Длительность медиа в секундах (контейнер), или null если ffprobe недоступен / ошибка. */
export function getMediaDurationSeconds(filePath: string): Promise<number | null> {
  const abs = resolve(filePath.trim())
  return new Promise((resolvePromise) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', abs],
      { windowsHide: true, timeout: 60_000 },
      (err, stdout) => {
        if (err) {
          resolvePromise(null)
          return
        }
        const v = Number.parseFloat(String(stdout).trim())
        resolvePromise(Number.isFinite(v) && v > 0 ? v : null)
      }
    )
  })
}
