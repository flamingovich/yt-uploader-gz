import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync } from 'node:fs'
import { URL } from 'node:url'

export function rewriteRtmpUrlForLocalTunnel(fullRtmpUrl: string, localPort: number): string {
  const raw = fullRtmpUrl.trim()
  const normalized = /^rtmps?:\/\//i.test(raw) ? raw : `rtmp://${raw}`
  const u = new URL(normalized)
  u.hostname = '127.0.0.1'
  u.port = String(localPort)
  return u.toString()
}

export function parseRtmpDestination(fullRtmpUrl: string): { host: string; port: number } {
  const raw = fullRtmpUrl.trim()
  const normalized = /^rtmps?:\/\//i.test(raw) ? raw : `rtmp://${raw}`
  const u = new URL(normalized)
  const host = u.hostname
  if (!host) throw new Error('Некорректный RTMP URL')
  const def = u.protocol === 'rtmps:' ? 443 : 1935
  const port = u.port ? Number.parseInt(u.port, 10) : def
  if (!Number.isFinite(port)) throw new Error('Некорректный порт RTMP')
  return { host, port }
}

export function combineRtmpUrl(ingestBase: string, streamKey: string): string {
  const b = ingestBase.trim().replace(/\/$/, '')
  const k = streamKey.trim().replace(/^\//, '')
  if (!b || !k) throw new Error('Заполните RTMP ingest URL и stream key')
  return `${b}/${k}`
}

function hasOverlay(overlayPath: string | null | undefined): boolean {
  if (!overlayPath?.trim()) return false
  try {
    accessSync(overlayPath)
    return true
  } catch {
    return false
  }
}

const OVERLAY_VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'])

/** Видео подложка (зациклить); иначе — картинка с -loop 1. */
export function isOverlayVideoFile(overlayPath: string): boolean {
  const p = overlayPath.trim().toLowerCase()
  const dot = p.lastIndexOf('.')
  if (dot === -1) return false
  return OVERLAY_VIDEO_EXT.has(p.slice(dot))
}

/** Shorts 1080×1920; куски (напр. 1920×1080) → 1080×608, размещение выше центра кадра. */
const CANVAS_W = 1080
const CANVAS_H = 1920
const SEGMENT_BOX_W = 1080
const SEGMENT_BOX_H = 608
const SEGMENT_CENTER_Y = 920
const SEGMENT_OVERLAY_Y = SEGMENT_CENTER_Y - SEGMENT_BOX_H / 2

export function buildFfmpegStreamArgs(input: {
  concatListPath: string
  outputRtmpUrl: string
  overlayPath: string | null
  extraArgs: string | null
}): string[] {
  const overlayOn = hasOverlay(input.overlayPath)
  /** Фон: оверлей на весь кадр (cover + crop, без чёрных полей). Поверх — уменьшенные куски. */
  const bgFull = `[0:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H}:(iw-ow)/2:(ih-oh)/2,setsar=1[base]`
  const fgScaled = `[1:v]scale=${SEGMENT_BOX_W}:${SEGMENT_BOX_H}[fg]`
  const stackOnOverlay = `${bgFull};${fgScaled};[base][fg]overlay=0:${SEGMENT_OVERLAY_Y}:format=auto[outv]`
  /** Без оверлея — запасной вариант с pad (чёрные поля только в этом режиме). */
  const padOnly = `[0:v]scale=${SEGMENT_BOX_W}:${SEGMENT_BOX_H}[fg];[fg]pad=${CANVAS_W}:${CANVAS_H}:0:${SEGMENT_OVERLAY_Y}:black,setsar=1[outv]`

  let filterComplex: string
  let maps: string[]
  if (overlayOn) {
    filterComplex = stackOnOverlay
    maps = ['-map', '[outv]', '-map', '1:a?']
  } else {
    filterComplex = padOnly
    maps = ['-map', '[outv]', '-map', '0:a?']
  }

  const base: string[] = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1']
  const concatListArg = input.concatListPath.trim().replace(/\\/g, '/')
  const overlayFs = input.overlayPath!.trim().replace(/\\/g, '/')
  if (overlayOn) {
    if (isOverlayVideoFile(input.overlayPath!)) {
      base.push('-stream_loop', '-1', '-i', overlayFs)
    } else {
      base.push('-loop', '1', '-i', overlayFs)
    }
    base.push('-re', '-f', 'concat', '-safe', '0', '-i', concatListArg)
  } else {
    base.push('-re', '-f', 'concat', '-safe', '0', '-i', concatListArg)
  }
  base.push(
    '-filter_complex',
    filterComplex,
    ...maps,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-g',
    '60',
    '-keyint_min',
    '60',
    '-b:v',
    '6000k',
    '-minrate',
    '6000k',
    '-maxrate',
    '6000k',
    '-bufsize',
    '12000k',
    '-x264-params',
    'nal-hrd=cbr:force-cfr=1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-f',
    'flv',
    input.outputRtmpUrl
  )

  const extra = (input.extraArgs ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (extra.length) {
    const flvIdx = base.lastIndexOf('-f')
    if (flvIdx !== -1) base.splice(flvIdx, 0, ...extra)
  }
  return base
}

export function buildFfmpegBumperArgs(input: {
  concatListPath: string
  outputRtmpUrl: string
  extraArgs: string | null
}): string[] {
  const base: string[] = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-stats_period',
    '1',
    '-re',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    input.concatListPath.trim().replace(/\\/g, '/'),
    '-map',
    '0:v',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-g',
    '60',
    '-keyint_min',
    '60',
    '-b:v',
    '6000k',
    '-minrate',
    '6000k',
    '-maxrate',
    '6000k',
    '-bufsize',
    '12000k',
    '-x264-params',
    'nal-hrd=cbr:force-cfr=1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-f',
    'flv',
    input.outputRtmpUrl
  ]
  const extra = (input.extraArgs ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (extra.length) {
    const flvIdx = base.lastIndexOf('-f')
    if (flvIdx !== -1) base.splice(flvIdx, 0, ...extra)
  }
  return base
}

/** Одна вертикальная заглушка с диска. Если `padDurationSecIfShorter` задан — зациклить вход до этой длительности (сек). */
export function buildFfmpegBumperDirectArgs(input: {
  inputFile: string
  outputRtmpUrl: string
  extraArgs: string | null
  /** Напр. 180: если ролик короче — крутить в цикле ровно столько секунд эфира. */
  padDurationSecIfShorter?: number
}): string[] {
  const file = input.inputFile.trim().replace(/\\/g, '/')
  const pad = input.padDurationSecIfShorter
  const base: string[] = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1']
  if (pad != null && pad > 0) {
    base.push('-re', '-stream_loop', '-1', '-i', file, '-t', String(pad))
  } else {
    base.push('-re', '-i', file)
  }
  base.push(
    '-map',
    '0:v',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-g',
    '60',
    '-keyint_min',
    '60',
    '-b:v',
    '6000k',
    '-minrate',
    '6000k',
    '-maxrate',
    '6000k',
    '-bufsize',
    '12000k',
    '-x264-params',
    'nal-hrd=cbr:force-cfr=1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-f',
    'flv',
    input.outputRtmpUrl
  )
  const extra = (input.extraArgs ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (extra.length) {
    const flvIdx = base.lastIndexOf('-f')
    if (flvIdx !== -1) base.splice(flvIdx, 0, ...extra)
  }
  return base
}

/**
 * Майнкрафт-прогрев: куски уже вертикальные 1080×1920 — без оверлея и без «окна» на подложке;
 * только выравнивание к Shorts-кадру + микс SFX и музыки.
 */
export function buildFfmpegStreamArgsMinecraftPrewarm(input: {
  concatListPath: string
  sfxConcatListPath: string
  musicConcatListPath: string
  outputRtmpUrl: string
  extraArgs: string | null
}): string[] {
  const concatVideo = input.concatListPath.trim().replace(/\\/g, '/')
  const concatSfx = input.sfxConcatListPath.trim().replace(/\\/g, '/')
  const concatMusic = input.musicConcatListPath.trim().replace(/\\/g, '/')

  const videoFullVertical = `[0:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H}:(iw-ow)/2:(ih-oh)/2,setsar=1,format=yuv420p[outv]`
  /** Музыка (вход 2) — ~10% громкости относительно SFX при миксе. */
  const amixBlock =
    `[1:a]aresample=44100[sfxa];[2:a]aresample=44100,volume=0.1[musa];[sfxa][musa]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[aud]`
  const filterComplex = `${videoFullVertical};${amixBlock}`
  const maps = ['-map', '[outv]', '-map', '[aud]']

  const base: string[] = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1']
  base.push('-re', '-f', 'concat', '-safe', '0', '-i', concatVideo)
  base.push('-re', '-f', 'concat', '-safe', '0', '-i', concatSfx)
  base.push('-re', '-f', 'concat', '-safe', '0', '-i', concatMusic)
  base.push(
    '-filter_complex',
    filterComplex,
    ...maps,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-g',
    '60',
    '-keyint_min',
    '60',
    '-b:v',
    '6000k',
    '-minrate',
    '6000k',
    '-maxrate',
    '6000k',
    '-bufsize',
    '12000k',
    '-x264-params',
    'nal-hrd=cbr:force-cfr=1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-f',
    'flv',
    input.outputRtmpUrl
  )

  const extra = (input.extraArgs ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (extra.length) {
    const flvIdx = base.lastIndexOf('-f')
    if (flvIdx !== -1) base.splice(flvIdx, 0, ...extra)
  }
  return base
}

export function spawnFfmpeg(args: string[]): ChildProcess {
  return spawn('ffmpeg', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
}
