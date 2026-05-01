import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm'])

/**
 * Артефакт Windows: `path.join('C:', 'D:\\a')` → `C:\\D\\a` → в UI `C:/D:/a`. Убираем ложный первый диск,
 * если сразу следует настоящий `X:/` или `X:\`.
 */
function stripSpuriousDrivePrefix(t: string): string {
  return t.replace(/^[A-Za-z]:[\\/]+(?=[A-Za-z]:[\\/])/i, '')
}

/** Windows: resolve + нормализация; в concat — обычный путь `D:/.../имя.mp4`, не URI с %XX. */
function normalizeFsPath(p: string): string {
  let t = p.trim()
  if (/^file:/i.test(t)) {
    try {
      t = fileURLToPath(t)
    } catch {
      /* keep */
    }
  }
  return stripSpuriousDrivePrefix(t)
}

/** Пути в БД (оверлей, заглушка, папка кусков, превью): исправить битый префикс и обрезку. */
export function sanitizeStreamerFsPathForDb(p: string | null | undefined): string | null {
  const v = p?.trim()
  if (!v) return null
  const n = normalizeFsPath(v)
  return n.length ? n : null
}

/**
 * Строка внутри `file '...'` для concat-демuxer.
 * Не использовать `pathToFileURL().href`: кириллица превращается в %XX и ffmpeg на Windows
 * часто отвечает «No such file or directory». Достаточно абсолютного пути со слэшами и кавычек ffmpeg.
 */
function concatFileDirectiveValue(absPath: string): string {
  const fsPath = resolve(normalizeFsPath(absPath))
  const posix = fsPath.replace(/\\/g, '/')
  return posix.replace(/'/g, `'\\''`)
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
}

export async function collectSegmentVideos(dir: string): Promise<string[]> {
  const root = resolve(normalizeFsPath(dir))
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase()
    if (!VIDEO_EXT.has(ext)) continue
    out.push(resolve(root, e.name))
  }
  return out.sort((a, b) => a.localeCompare(b))
}

export async function writeConcatListFile(input: {
  segmentPaths: string[]
}): Promise<string> {
  const lines: string[] = []
  const shuffled = [...input.segmentPaths]
  shuffleInPlace(shuffled)
  for (const p of shuffled) {
    lines.push(`file '${concatFileDirectiveValue(p)}'`)
  }
  const body = `${lines.join('\n')}\n`
  const name = `ytu-concat-${randomBytes(8).toString('hex')}.txt`
  const path = join(tmpdir(), name)
  await fsp.writeFile(path, body, 'utf8')
  return path
}

/** Максимум строк в одном ffconcat, чтобы не раздувать файл и память demuxer. */
const MAX_CONCAT_LINES = 55_000

/**
 * Несколько полных проходов по набору кусков: каждый проход — новый shuffle.
 * Один длинный concat позволяет не перезапускать ffmpeg после каждого круга (один RTMP-паблиш).
 */
export async function writeConcatListFileMultiShuffledPasses(input: {
  segmentPaths: string[]
}): Promise<string> {
  const n = input.segmentPaths.length
  if (n < 1) throw new Error('Нет сегментов')
  let passes = Math.max(24, Math.floor(MAX_CONCAT_LINES / n))
  passes = Math.min(800, passes)
  const lines: string[] = []
  for (let c = 0; c < passes; c += 1) {
    const shuffled = [...input.segmentPaths]
    shuffleInPlace(shuffled)
    for (const p of shuffled) {
      lines.push(`file '${concatFileDirectiveValue(p)}'`)
    }
  }
  const body = `${lines.join('\n')}\n`
  const name = `ytu-concat-multi-${randomBytes(8).toString('hex')}.txt`
  const path = join(tmpdir(), name)
  await fsp.writeFile(path, body, 'utf8')
  return path
}

export async function writeSingleVideoConcatList(videoPath: string): Promise<string> {
  const fsPath = resolve(normalizeFsPath(videoPath))
  await fsp.access(fsPath)
  const body = `file '${concatFileDirectiveValue(fsPath)}'\n`
  const name = `ytu-single-${randomBytes(8).toString('hex')}.txt`
  const path = join(tmpdir(), name)
  await fsp.writeFile(path, body, 'utf8')
  return path
}

export async function unlinkQuiet(path: string): Promise<void> {
  try {
    await fsp.unlink(path)
  } catch {
    /* ignore */
  }
}
