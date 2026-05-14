import { execFile } from 'node:child_process'
import { resolve } from 'node:path'

/** Длительность медиа в секундах (контейнер или дорожка), или null если ffprobe недоступен / ошибка. */
export function getMediaDurationSeconds(filePath: string): Promise<number | null> {
  const abs = resolve(filePath.trim())
  const probeFormat = (): Promise<number | null> =>
    new Promise((resolvePromise) => {
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

  const probeVideoStream = (): Promise<number | null> =>
    new Promise((resolvePromise) => {
      execFile(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          abs
        ],
        { windowsHide: true, timeout: 60_000 },
        (err, stdout) => {
          if (err) {
            resolvePromise(null)
            return
          }
          const lines = String(stdout)
            .trim()
            .split(/\n/)
            .map((l) => Number.parseFloat(l.trim()))
            .filter((n) => Number.isFinite(n) && n > 0)
          resolvePromise(lines.length ? Math.max(...lines) : null)
        }
      )
    })

  return (async () => {
    const fromFmt = await probeFormat()
    if (fromFmt != null && fromFmt > 0) return fromFmt
    return probeVideoStream()
  })()
}

/** Есть ли у файла хотя бы одна аудиодорожка (для микса с фоновой музыкой). */
export function ffprobeHasAudioStream(filePath: string): Promise<boolean> {
  const abs = resolve(filePath.trim())
  return new Promise((resolvePromise) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index', '-of', 'csv=p=0', abs],
      { windowsHide: true, timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          resolvePromise(false)
          return
        }
        resolvePromise(String(stdout).trim().length > 0)
      }
    )
  })
}
