import { createHash, randomBytes } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { getMediaDurationSeconds } from './ffprobe'

const execFile = promisify(execFileCallback)

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm'])
const NATURAL_COLLATOR = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

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
  return out.sort((a, b) => NATURAL_COLLATOR.compare(a, b))
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
export const MAX_CONCAT_LINES = 55_000

/** Сколько полных shuffle-проходов в длинном concat-листе (видео и SFX). */
export function streamerMultiPassCount(segmentCount: number): number {
  const n = segmentCount
  if (n < 1) return 24
  let passes = Math.max(24, Math.floor(MAX_CONCAT_LINES / n))
  passes = Math.min(800, passes)
  return passes
}

/** Как у `streamerMultiPassCount`, но на проход приходится `linesPerPass` строк concat (напр. клип + пауза). */
export function streamerMultiPassCountByLinesPerPass(linesPerPass: number): number {
  const lp = Math.max(1, Math.floor(linesPerPass))
  let passes = Math.max(24, Math.floor(MAX_CONCAT_LINES / lp))
  passes = Math.min(800, passes)
  return passes
}

/**
 * Несколько полных проходов по набору кусков: каждый проход — новый shuffle.
 * Один длинный concat позволяет не перезапускать ffmpeg после каждого круга (один RTMP-паблиш).
 */
export async function writeConcatListFileMultiShuffledPasses(input: {
  segmentPaths: string[]
}): Promise<string> {
  const n = input.segmentPaths.length
  if (n < 1) throw new Error('Нет сегментов')
  const passes = streamerMultiPassCount(n)
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

export async function writeConcatListFileMultiOrderedPasses(input: {
  segmentPaths: string[]
}): Promise<string> {
  const n = input.segmentPaths.length
  if (n < 1) throw new Error('Нет сегментов')
  const passes = streamerMultiPassCount(n)
  const ordered = [...input.segmentPaths]
  const lines: string[] = []
  for (let c = 0; c < passes; c += 1) {
    for (const p of ordered) {
      lines.push(`file '${concatFileDirectiveValue(p)}'`)
    }
  }
  const body = `${lines.join('\n')}\n`
  const name = `ytu-concat-ordered-${randomBytes(8).toString('hex')}.txt`
  const path = join(tmpdir(), name)
  await fsp.writeFile(path, body, 'utf8')
  return path
}

export async function writeSingleSegmentConcatListMultiPasses(input: {
  segmentPath: string
}): Promise<string> {
  const one = resolve(normalizeFsPath(input.segmentPath))
  await fsp.access(one)
  const passes = streamerMultiPassCount(1)
  const lines: string[] = []
  for (let i = 0; i < passes; i += 1) {
    lines.push(`file '${concatFileDirectiveValue(one)}'`)
  }
  const body = `${lines.join('\n')}\n`
  const name = `ytu-concat-single-${randomBytes(8).toString('hex')}.txt`
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

/** Паузы между SFX: 0.5…1.5 с с шагом 0.1 с (кэш коротких MP3 тишины в temp). */
const SILENCE_TENTHS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const

async function ensureSilenceMp3Caches(): Promise<Map<number, string>> {
  const dir = join(tmpdir(), 'ytu-mc-silence-mp3')
  await fsp.mkdir(dir, { recursive: true })
  const m = new Map<number, string>()
  for (const t of SILENCE_TENTHS) {
    const sec = t / 10
    const p = join(dir, `silence-${t}t.mp3`)
    try {
      await fsp.access(p)
    } catch {
      await execFile(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'anullsrc=r=44100:cl=stereo',
          '-t',
          String(sec),
          '-c:a',
          'libmp3lame',
          '-b:a',
          '64k',
          p
        ],
        { windowsHide: true }
      )
    }
    m.set(t, p)
  }
  return m
}

function pickRandomSilenceMp3(silenceMap: Map<number, string>): string {
  const t = SILENCE_TENTHS[Math.floor(Math.random() * SILENCE_TENTHS.length)]!
  return silenceMap.get(t)!
}

/** Fade на краях каждого SFX (сек), чтобы склейки не «рвали» ухо. */
const MC_SFX_EDGE_FADE_SEC = 0.2

function buildAfadeInOutFilter(durationSec: number): string {
  const d = durationSec
  if (!Number.isFinite(d) || d < 0.06) {
    return 'anull'
  }
  let fin = MC_SFX_EDGE_FADE_SEC
  let fout = MC_SFX_EDGE_FADE_SEC
  const reserve = 0.02
  if (fin + fout + reserve > d) {
    const half = Math.max(0.02, (d - reserve) / 2)
    fin = Math.min(fin, half * 0.95)
    fout = Math.min(fout, half * 0.95)
  }
  const stOut = Math.max(0, d - fout)
  return `afade=t=in:st=0:d=${fin},afade=t=out:st=${stOut}:d=${fout}`
}

/**
 * Кэш в temp: один раз на (файл+mtime+size) прогоняем через afade in/out.
 * Используется только для майнкрафт-SFX concat.
 */
async function getOrCreateFadedSfxMp3(absPath: string): Promise<string> {
  const fsPath = resolve(normalizeFsPath(absPath))
  const st = await fsp.stat(fsPath)
  const sig = `${fsPath}\n${st.mtimeMs}\n${st.size}`
  const h = createHash('sha256').update(sig).digest('hex').slice(0, 48)
  const dir = join(tmpdir(), 'ytu-mc-sfx-faded')
  await fsp.mkdir(dir, { recursive: true })
  const outPath = join(dir, `${h}.mp3`)
  try {
    await fsp.access(outPath)
    return outPath
  } catch {
    /* generate */
  }
  const dur = (await getMediaDurationSeconds(fsPath)) ?? 3
  const af = buildAfadeInOutFilter(dur)
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    fsPath,
    '-af',
    af,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    outPath
  ]
  await execFile('ffmpeg', args, { windowsHide: true })
  return outPath
}

/** Только .mp3 — concat demuxer стабильнее на одном кодеке. */
export async function collectMinecraftPrewarmAudioMp3(dir: string): Promise<string[]> {
  const root = resolve(normalizeFsPath(dir))
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase()
    if (ext !== '.mp3') continue
    out.push(resolve(root, e.name))
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/**
 * SFX: несколько shuffle-проходов; после каждого клипа — случайная пауза 0.5–1.5 с.
 * Две строки на клип (аудио + тишина), лимит строк как у видео-concat.
 */
export async function writeMinecraftSfxConcatListMultiPasses(input: {
  audioPaths: string[]
}): Promise<string> {
  const n = input.audioPaths.length
  if (n < 1) throw new Error('Нет MP3 в папке SFX')
  const silenceMap = await ensureSilenceMp3Caches()
  const key = (p: string): string => resolve(normalizeFsPath(p))
  const uniqueKeys = [...new Set(input.audioPaths.map(key))]
  const fadedByKey = new Map<string, string>()
  for (const k of uniqueKeys) {
    fadedByKey.set(k, await getOrCreateFadedSfxMp3(k))
  }
  const passes = streamerMultiPassCountByLinesPerPass(n * 2)
  const lines: string[] = []
  for (let c = 0; c < passes; c += 1) {
    const shuffled = [...input.audioPaths]
    shuffleInPlace(shuffled)
    for (const p of shuffled) {
      const faded = fadedByKey.get(key(p))!
      lines.push(`file '${concatFileDirectiveValue(faded)}'`)
      lines.push(`file '${concatFileDirectiveValue(pickRandomSilenceMp3(silenceMap))}'`)
    }
  }
  const body = `${lines.join('\n')}\n`
  const name = `ytu-mc-sfx-${randomBytes(8).toString('hex')}.txt`
  const path = join(tmpdir(), name)
  await fsp.writeFile(path, body, 'utf8')
  return path
}

/** Один и тот же MP3 повторяется в concat-листе, чтобы музыка не обрывалась раньше длинного видео-плейлиста. */
export async function writeMusicRepeatConcatList(input: {
  musicPath: string
  targetMinDurationSec: number
}): Promise<string> {
  const fsPath = resolve(normalizeFsPath(input.musicPath))
  await fsp.access(fsPath)
  const duration = (await getMediaDurationSeconds(fsPath)) ?? 180
  let repeats = Math.ceil(input.targetMinDurationSec / duration)
  repeats = Math.max(80, Math.min(8000, repeats))
  const lines: string[] = []
  for (let i = 0; i < repeats; i += 1) {
    lines.push(`file '${concatFileDirectiveValue(fsPath)}'`)
  }
  const body = `${lines.join('\n')}\n`
  const name = `ytu-mc-music-${randomBytes(8).toString('hex')}.txt`
  const path = join(tmpdir(), name)
  await fsp.writeFile(path, body, 'utf8')
  return path
}
