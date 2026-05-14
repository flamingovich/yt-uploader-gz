import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, readdirSync } from 'node:fs'
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

export const STREAM_VIDEO_FPS_OPTIONS = [24, 30, 50, 60] as const

/** Нормализует разрешение (720×1280, 900×1600 или 1080×1920) и FPS из полей стримера. */
export function normalizeStreamVideoOutput(input: {
  stream_output_width?: number | null
  stream_output_height?: number | null
  stream_video_fps?: number | null
}): { width: number; height: number; fps: number } {
  const fp = Math.floor(Number(input.stream_video_fps))
  const fps = (STREAM_VIDEO_FPS_OPTIONS as readonly number[]).includes(fp) ? fp : 30
  const w = Math.floor(Number(input.stream_output_width))
  const h = Math.floor(Number(input.stream_output_height))
  if (w === 720 && h === 1280) return { width: 720, height: 1280, fps }
  if (w === 900 && h === 1600) return { width: 900, height: 1600, fps }
  return { width: 1080, height: 1920, fps }
}

/** Пропорции «окна» куска как при 1080×1920, масштабированные под выбранный canvas. */
export function streamCanvasLayoutMetrics(canvasW: number, canvasH: number): {
  segW: number
  segH: number
  overlayY: number
} {
  const segW = canvasW
  const segH = Math.max(200, Math.round((608 * canvasH) / 1920))
  const centerY = Math.round((920 * canvasH) / 1920)
  const overlayY = Math.round(centerY - segH / 2)
  return { segW, segH, overlayY }
}

function bumperStackOverlayFilter(
  cw: number,
  ch: number,
  segW: number,
  segH: number,
  y: number
): string {
  /** Вход 0 — ролик с `-re`; вход 1 — loop-оверлей. `eof_action=endall` — иначе при EOF ролика оверлей тянет видео бесконечно. */
  return `[1:v]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch}:(iw-ow)/2:(ih-oh)/2,setsar=1[base];[0:v]scale=${segW}:${segH}[fg];[base][fg]overlay=0:${y}:format=auto:eof_action=endall[outvraw]`
}

function bumperPadOnlyFilter(cw: number, ch: number, segW: number, segH: number, y: number): string {
  return `[0:v]scale=${segW}:${segH}[fg];[fg]pad=${cw}:${ch}:0:${y}:black,setsar=1[outvraw]`
}

function bumperVideoTailFps(fps: number, durationSec: number): string {
  const d = Math.max(1, Math.floor(durationSec))
  return `[outvraw]trim=duration=${d}[outvtrim];[outvtrim]setpts=PTS-STARTPTS[outvp];[outvp]fps=fps=${fps}:round=near,format=yuv420p[outv]`
}

type StreamPreviewLayout = {
  videoScale?: number
  overlayScale?: number
  textScale?: number
  videoLayer?: number
  overlayLayer?: number
  textLayerLevel?: number
  video?: { x?: number; y?: number }
  overlay?: { x?: number; y?: number } | null
  text?: {
    x?: number
    y?: number
    content?: string
    font?: string
    fontFilePath?: string | null
    size?: number
    color?: string
    strokeColor?: string
    strokeSize?: number
    visible?: boolean
  }
}

type StreamPreviewLayoutSource = {
  id?: string
  type?: string
  visible?: boolean
  z?: number
  x?: number
  y?: number
  w?: number
  h?: number
  src?: string | null
  filePath?: string | null
  text?: {
    content?: string
    font?: string
    fontFilePath?: string | null
    size?: number
    color?: string
    strokeColor?: string
    strokeSize?: number
    visible?: boolean
  } | null
}

type StreamPreviewLayoutV2 = {
  previewScale?: number
  /** Громкость основного видео (куски стрима / начальная сцена), %: 10–250, по умолчанию 100. */
  mainAudioGainPercent?: number
  /** Громкость фоновой музыки в предпросмотре, %: 0–200 (сохраняется в layout канала). */
  previewMusicVolumePercent?: number
  sources?: StreamPreviewLayoutSource[]
}

function toInt(n: unknown, fallback: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.round(v)
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/** macOS: декод concat через VideoToolbox (меньше CPU при длинном 1080p). Отключить при сбоях: YTGZ_STREAM_VTB_DECODE=0 */
function concatHwDecodePreArgs(): string[] {
  if (process.platform !== 'darwin') return []
  if (process.env.YTGZ_STREAM_VTB_DECODE === '0') return []
  return ['-hwaccel', 'videotoolbox']
}

/** Отключить HarfBuzz в drawtext (дешевле CPU; только латиница/цифры без проблем). YTGZ_STREAM_DRAWTEXT_SHAPING=0 */
function drawtextShapingPart(): string {
  return process.env.YTGZ_STREAM_DRAWTEXT_SHAPING === '0' ? 'text_shaping=0' : 'text_shaping=1'
}

/** 10–250 % усиления звука основного видео из JSON предпросмотра (основной эфир или начальная сцена). */
export function parseMainAudioGainPercentFromPreviewLayoutJson(raw: string | null | undefined): number {
  const s = String(raw ?? '').trim()
  if (!s) return 100
  try {
    const j = JSON.parse(s) as StreamPreviewLayoutV2
    if (!j || typeof j !== 'object') return 100
    return clamp(Number(j.mainAudioGainPercent ?? 100), 10, 250)
  } catch {
    return 100
  }
}

/** Громкость фона из JSON предпросмотра (0–200), если поле задано — как в окне предпросмотра. */
export function parsePreviewMusicVolumeFromLayoutJson(raw: string | null | undefined): number | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  try {
    const j = JSON.parse(s) as { previewMusicVolumePercent?: unknown }
    if (!j || typeof j !== 'object') return null
    const n = Math.floor(Number(j.previewMusicVolumePercent))
    if (!Number.isFinite(n)) return null
    return clamp(n, 0, 200)
  } catch {
    return null
  }
}

function parsePreviewLayout(raw: string | null | undefined): StreamPreviewLayout | null {
  if (!raw?.trim()) return null
  try {
    const j = JSON.parse(raw) as StreamPreviewLayout
    if (!j || typeof j !== 'object') return null
    return j
  } catch {
    return null
  }
}

function normalizePathFromLayoutSource(s: StreamPreviewLayoutSource): string | null {
  const fromFilePath = String(s.filePath ?? '').trim()
  if (fromFilePath) return fromFilePath
  const src = String(s.src ?? '').trim()
  if (!src) return null
  if (/^file:\/\//i.test(src)) {
    try {
      const u = new URL(src)
      if (u.protocol !== 'file:') return null
      const p = decodeURIComponent(u.pathname || '')
      if (/^\/[A-Za-z]:\//.test(p)) return p.slice(1).replace(/\//g, '\\')
      return p || null
    } catch {
      return null
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(src) || src.startsWith('/')) return src
  return null
}

function toLegacyLayoutFromSources(
  raw: StreamPreviewLayoutV2,
  defaultOverlayPath: string | null
): { layout: StreamPreviewLayout | null; overlayPath: string | null } {
  const srcs = Array.isArray(raw.sources) ? raw.sources : []
  if (srcs.length < 1) return { layout: null, overlayPath: defaultOverlayPath }

  const visible = srcs.filter((s) => s && typeof s === 'object' && s.visible !== false)
  const video = visible.find((s) => s.type === 'video') ?? srcs.find((s) => s.type === 'video')
  const textSources = visible.filter((s) => s.type === 'text' && s.text?.visible !== false && String(s.text?.content ?? '').trim())
  const topText = textSources.sort((a, b) => Number(b.z ?? 0) - Number(a.z ?? 0))[0]
  const mediaSources = visible.filter((s) => s.type === 'overlay' || s.type === 'image' || s.type === 'gif')
  const topOverlay = mediaSources.sort((a, b) => Number(b.z ?? 0) - Number(a.z ?? 0))[0]

  const videoW = Math.max(1, Number(video?.w ?? 360))
  const overlayW = Math.max(1, Number(topOverlay?.w ?? 336))
  const layout: StreamPreviewLayout = {
    videoScale: clamp(Math.round((videoW / 360) * 100), 20, 220),
    overlayScale: clamp(Math.round((overlayW / 336) * 100), 20, 220),
    videoLayer: Number(video?.z ?? 10),
    overlayLayer: Number(topOverlay?.z ?? 20),
    video: {
      x: Number(video?.x ?? 0),
      y: Number(video?.y ?? 0)
    },
    overlay: topOverlay
      ? {
          x: Number(topOverlay.x ?? 12),
          y: Number(topOverlay.y ?? 12)
        }
      : null,
    text: topText
      ? {
          x: Number(topText.x ?? 40),
          y: Number(topText.y ?? 40),
          content: String(topText.text?.content ?? ''),
          font: topText.text?.font,
          fontFilePath: topText.text?.fontFilePath ?? null,
          size: Number(topText.text?.size ?? 42),
          color: topText.text?.color,
          strokeColor: topText.text?.strokeColor,
          strokeSize: Number(topText.text?.strokeSize ?? 2),
          visible: topText.text?.visible !== false
        }
      : undefined
  }

  const overlayPathFromSource = topOverlay ? normalizePathFromLayoutSource(topOverlay) : null
  const overlayPath = topOverlay ? overlayPathFromSource : null
  return { layout, overlayPath: overlayPath ?? defaultOverlayPath }
}

function escDrawText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\n/g, '\\n')
}

function normalizeFontFamilyKey(v: string): string {
  return v
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function firstExistingPath(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      accessSync(c)
      return c
    } catch {
      // keep looking
    }
  }
  return null
}

type FontEntry = { path: string; baseKey: string; tokens: string[] }
let cachedWindowsFonts: FontEntry[] | null = null
type RegistryFontEntry = { displayName: string; displayKey: string; path: string; baseKey: string; tokens: string[] }
let cachedWindowsRegistryFonts: RegistryFontEntry[] | null = null

function splitTokens(v: string): string[] {
  return v
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
}

function normalizeAlphaNum(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function loadWindowsFontsIndex(): FontEntry[] {
  if (cachedWindowsFonts) return cachedWindowsFonts
  const dir = 'C:/Windows/Fonts'
  let files: string[] = []
  try {
    files = readdirSync(dir, { withFileTypes: false })
  } catch {
    cachedWindowsFonts = []
    return cachedWindowsFonts
  }
  const out: FontEntry[] = []
  for (const name of files) {
    const lower = name.toLowerCase()
    if (!lower.endsWith('.ttf') && !lower.endsWith('.otf') && !lower.endsWith('.ttc')) continue
    const full = `${dir}/${name}`
    const stem = name.replace(/\.(ttf|otf|ttc)$/i, '')
    out.push({
      path: full,
      baseKey: normalizeAlphaNum(stem),
      tokens: splitTokens(stem)
    })
  }
  cachedWindowsFonts = out
  return out
}

function parseRegQueryFontsOutput(raw: string): Array<{ displayName: string; fileValue: string }> {
  const out: Array<{ displayName: string; fileValue: string }> = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([^\r\n\t].*?)\s+REG_\w+\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const displayName = String(m[1] || '').trim()
    const fileValue = String(m[2] || '').trim()
    if (!displayName || !fileValue) continue
    out.push({ displayName, fileValue })
  }
  return out
}

function normalizeWindowsFontPath(v: string): string {
  const t = String(v || '').trim().replace(/\\/g, '/')
  if (!t) return ''
  if (/^[A-Za-z]:\//.test(t)) return t
  return `C:/Windows/Fonts/${t}`
}

function loadWindowsRegistryFontsIndex(): RegistryFontEntry[] {
  if (cachedWindowsRegistryFonts) return cachedWindowsRegistryFonts
  if (process.platform !== 'win32') {
    cachedWindowsRegistryFonts = []
    return cachedWindowsRegistryFonts
  }
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
  ]
  const rows: RegistryFontEntry[] = []
  for (const root of roots) {
    let out = ''
    try {
      out = execFileSync('reg', ['query', root], { encoding: 'utf8', windowsHide: true })
    } catch {
      continue
    }
    const parsed = parseRegQueryFontsOutput(out)
    for (const item of parsed) {
      const path = normalizeWindowsFontPath(item.fileValue)
      if (!path) continue
      try {
        accessSync(path)
      } catch {
        continue
      }
      const displayName = item.displayName.replace(/\s*\(truetype\)\s*$/i, '').trim()
      const stem = path.split('/').pop()?.replace(/\.(ttf|otf|ttc)$/i, '') || displayName
      rows.push({
        displayName,
        displayKey: normalizeAlphaNum(displayName),
        path,
        baseKey: normalizeAlphaNum(stem),
        tokens: splitTokens(displayName)
      })
    }
  }
  cachedWindowsRegistryFonts = rows
  return rows
}

function resolveWindowsFontByFamilyFromRegistry(family: string): string | null {
  const fam = family.trim()
  if (!fam) return null
  const famTokens = splitTokens(fam)
  if (famTokens.length < 1) return null
  const famKey = normalizeAlphaNum(fam)
  const entries = loadWindowsRegistryFontsIndex()
  if (entries.length < 1) return null

  let best: { score: number; path: string } | null = null
  for (const entry of entries) {
    let score = 0
    if (entry.displayKey === famKey) score += 1600
    if (entry.displayKey.startsWith(famKey)) score += 900
    if (entry.displayKey.includes(famKey)) score += 650
    if (entry.baseKey === famKey) score += 900
    for (const t of famTokens) {
      if (entry.tokens.includes(t)) score += 140
      else if (entry.displayKey.includes(t)) score += 60
      else if (entry.baseKey.includes(t)) score += 40
    }
    const p = entry.path.toLowerCase()
    if (p.endsWith('.ttf')) score += 15
    if (p.includes('bold') || p.includes('bd')) score -= 10
    if (score <= 0) continue
    if (!best || score > best.score) best = { score, path: entry.path }
  }
  return best?.score && best.score >= 350 ? best.path : null
}

function resolveWindowsFontByFamily(family: string): string | null {
  const fam = family.trim()
  if (!fam) return null
  const famTokens = splitTokens(fam)
  if (famTokens.length < 1) return null
  const famKey = normalizeAlphaNum(fam)
  const fonts = loadWindowsFontsIndex()
  if (fonts.length < 1) return null

  let best: { score: number; path: string } | null = null
  for (const entry of fonts) {
    let score = 0
    if (entry.baseKey === famKey) score += 1200
    if (entry.baseKey.includes(famKey)) score += 700
    if (famKey.includes(entry.baseKey) && entry.baseKey.length > 4) score += 250
    for (const t of famTokens) {
      if (entry.tokens.includes(t)) score += 120
      else if (entry.baseKey.includes(t)) score += 50
    }
    if (entry.path.toLowerCase().endsWith('.ttf')) score += 20
    // Prefer regular variants when names are very close.
    const p = entry.path.toLowerCase()
    if (p.includes('regular')) score += 10
    if (score <= 0) continue
    if (!best || score > best.score) best = { score, path: entry.path }
  }
  return best?.score && best.score >= 250 ? best.path : null
}

function pickDrawtextFontSpec(preferredFamilyOrPath: string | null | undefined): { mode: 'fontfile'; value: string } {
  const pref = String(preferredFamilyOrPath ?? '').trim()
  // User requested one standard font for preview + stream/render.
  // Keep explicit path support only if it is already a concrete font file.
  if (pref && /^[A-Za-z]:[\\/]/.test(pref)) {
    try {
      accessSync(pref)
      return { mode: 'fontfile', value: pref }
    } catch {
      // ignore and fall back to standard
    }
  }
  const fallback = firstExistingPath([
    'C:/Windows/Fonts/arial.ttf',
    'C:/Windows/Fonts/segoeui.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf'
  ])
  if (fallback) return { mode: 'fontfile', value: fallback }
  // Last-resort static path for Windows environments where probing fails for transient reasons.
  return { mode: 'fontfile', value: 'C:/Windows/Fonts/arial.ttf' }
}

function buildFfmpegStreamArgsFromSourcesLayout(
  input: {
    concatListPath: string
    outputRtmpUrl: string
    overlayPath: string | null
    videoBitrateKbps: number
    videoBitrateMode: 'cbr' | 'vbr'
    extraArgs: string | null
    outputWidth: number
    outputHeight: number
    outputFps: number
    /** Concat-лист с треками; `-stream_loop -1` снаружи. */
    streamMusicConcatListPath?: string | null
    /** 0–200 (%), применяется как `volume=` к ветке музыки. */
    streamMusicVolumePercent?: number | null
    /** Есть ли аудио у входа concat (куски стрима). */
    concatVideoHasAudio?: boolean | null
    /** 10–250 (%), усиление/ослабление звука кусков перед миксом. */
    mainAudioGainPercent?: number | null
  },
  raw: StreamPreviewLayoutV2
): string[] | null {
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter((s) => s && typeof s === 'object' && s.visible !== false)
    : []
  if (sources.length < 1) return null
  const stageW = 360
  const stageH = 640
  const cw = input.outputWidth
  const ch = input.outputHeight
  const fps = input.outputFps
  const sx = cw / stageW
  const sy = ch / stageH
  const pxToCanvas = (n: number): number => Math.round(n * (sx + sy) / 2)

  const videoSource =
    sources.find((s) => s.type === 'video') ??
    (Array.isArray(raw.sources) ? raw.sources.find((s) => s?.type === 'video') ?? null : null)
  if (!videoSource) return null

  const chain: string[] = [`color=c=black:s=${cw}x${ch}:r=${fps}[base0]`]
  const concatListArg = input.concatListPath.trim().replace(/\\/g, '/')
  const ffmpegArgs: string[] = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1']
  ffmpegArgs.push(
    ...concatHwDecodePreArgs(),
    '-thread_queue_size',
    '1024',
    '-re',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListArg
  )

  type MediaOp = { z: number; label: string; x: number; y: number; order: number }
  type TextOp = {
    z: number
    kind: 'text'
    x: number
    y: number
    content: string
    font: string
    fontFilePath: string | null
    size: number
    color: string
    strokeColor: string
    strokeSize: number
    order: number
  }
  type Op = MediaOp | TextOp
  const ops: Op[] = []

  const vw = clamp(Math.round(Number(videoSource.w ?? 360) * sx), 40, 3000)
  const vh = clamp(Math.round(Number(videoSource.h ?? 640) * sy), 40, 3000)
  chain.push(`[0:v]scale=${vw}:${vh}:force_original_aspect_ratio=decrease[v0]`)
  ops.push({
    z: Number(videoSource.z ?? 10),
    label: 'v0',
    x: Math.round(Number(videoSource.x ?? 0) * sx),
    y: Math.round(Number(videoSource.y ?? 0) * sy),
    order: 0
  })

  let mediaInputIdx = 1
  let mediaOrder = 1
  for (const s of sources) {
    const t = String(s.type ?? '')
    if (t !== 'overlay' && t !== 'image' && t !== 'gif') continue
    // `overlay-root` в предпросмотре хранит snapshot-кадр из temp-пути; в live-стриме
    // всегда подставляем актуальный overlayPath стримера, чтобы не залипать на старом оверлее.
    const fsPath =
      t === 'overlay' && String(s.id ?? '').trim() === 'overlay-root'
        ? String(input.overlayPath ?? '').trim() || null
        : normalizePathFromLayoutSource(s)
    if (!fsPath || !hasOverlay(fsPath)) continue
    const pathArg = fsPath.trim().replace(/\\/g, '/')
    if (t === 'gif' || isOverlayVideoFile(fsPath)) {
      ffmpegArgs.push('-thread_queue_size', '256', '-stream_loop', '-1', '-i', pathArg)
    } else {
      ffmpegArgs.push('-thread_queue_size', '256', '-loop', '1', '-i', pathArg)
    }
    const w = clamp(Math.round(Number(s.w ?? 336) * sx), 20, 3000)
    const h = clamp(Math.round(Number(s.h ?? 616) * sy), 20, 3000)
    const label = `m${mediaInputIdx}`
    chain.push(`[${mediaInputIdx}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[${label}]`)
    ops.push({
      z: Number(s.z ?? 20),
      label,
      x: Math.round(Number(s.x ?? 12) * sx),
      y: Math.round(Number(s.y ?? 12) * sy),
      order: mediaOrder
    })
    mediaInputIdx += 1
    mediaOrder += 1
  }

  let textOrder = 1000
  for (const s of sources) {
    if (s.type !== 'text') continue
    const txt = s.text ?? null
    const content = String(txt?.content ?? '').trim()
    if (!content || txt?.visible === false) continue
    ops.push({
      kind: 'text',
      z: Number(s.z ?? 30),
      x: Math.round(Number(s.x ?? 40) * sx),
      y: Math.round(Number(s.y ?? 40) * sy),
      content,
      font: String(txt?.font ?? 'Arial').trim() || 'Arial',
      fontFilePath: String(txt?.fontFilePath ?? '').trim() || null,
      size: clamp(pxToCanvas(Number(txt?.size ?? 42)), 10, 300),
      color: String(txt?.color ?? '#ffffff').replace('#', ''),
      strokeColor: String(txt?.strokeColor ?? '#000000').replace('#', ''),
      strokeSize: clamp(pxToCanvas(Number(txt?.strokeSize ?? 2)), 0, 24),
      order: textOrder
    })
    textOrder += 1
  }

  ops.sort((a, b) => {
    const dz = Number(a.z || 0) - Number(b.z || 0)
    if (dz !== 0) return dz
    return Number(a.order || 0) - Number(b.order || 0)
  })

  let cur = 'base0'
  let step = 0
  for (const op of ops) {
    step += 1
    const next = `base${step}`
    if ('kind' in op && op.kind === 'text') {
      const textEsc = escDrawText(op.content)
      const fontSpec = pickDrawtextFontSpec(op.fontFilePath || op.font)
      const fontPart = `fontfile='${escDrawText(fontSpec.value)}'`
      chain.push(
        `[${cur}]drawtext=text='${textEsc}':${fontPart}:${drawtextShapingPart()}:x=${op.x}:y=${op.y}:fontcolor=${op.color}:fontsize=${op.size}:borderw=${op.strokeSize}:bordercolor=${op.strokeColor}[${next}]`
      )
    } else {
      chain.push(`[${cur}][${op.label}]overlay=${op.x}:${op.y}:format=auto[${next}]`)
    }
    cur = next
  }
  chain.push(`[${cur}]format=yuv420p[outvraw]`)
  chain.push(`[outvraw]fps=fps=${fps}:round=near,format=yuv420p[outv]`)

  const musicListRaw = String(input.streamMusicConcatListPath ?? '').trim()
  const musicOn = Boolean(musicListRaw)
  const musicIdx = mediaInputIdx
  if (musicOn) {
    ffmpegArgs.push('-thread_queue_size', '256', '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', musicListRaw.replace(/\\/g, '/'))
  }

  const mainGainPct = clamp(Number(input.mainAudioGainPercent ?? 100), 10, 250)
  const mainGainLin = mainGainPct / 100
  const musVolPct = clamp(Number(input.streamMusicVolumePercent ?? 100), 0, 200)
  const musVolLin = musVolPct / 100
  const hasMainA = Boolean(input.concatVideoHasAudio)

  let audioGraph: string
  if (musicOn && hasMainA) {
    audioGraph = `[0:a]volume=${mainGainLin},aresample=44100[va];[${musicIdx}:a]aresample=44100,volume=${musVolLin}[mus];[va][mus]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aud]`
  } else if (musicOn && !hasMainA) {
    audioGraph = `[${musicIdx}:a]aresample=44100,volume=${musVolLin}[aud]`
  } else if (hasMainA) {
    audioGraph = `[0:a]volume=${mainGainLin},aresample=44100[aud]`
  } else {
    audioGraph = `anullsrc=r=44100:cl=stereo,atrim=end=86400,asetpts=N/SR/TB[aud]`
  }

  const filterComplex = `${chain.join(';')};${audioGraph}`

  ffmpegArgs.push(
    '-filter_complex',
    filterComplex,
    '-map',
    '[outv]',
    '-map',
    '[aud]',
    ...buildLiveStreamVideoEncodeArgs(input.videoBitrateMode, input.videoBitrateKbps, fps),
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
    const flvIdx = ffmpegArgs.lastIndexOf('-f')
    if (flvIdx !== -1) ffmpegArgs.splice(flvIdx, 0, ...extra)
  }
  return ffmpegArgs
}

/** Только битрейт/буфер (без x264-params) — для энкодеров вроде h264_videotoolbox. */
function buildVideoBitrateArgsOnly(modeRaw: 'cbr' | 'vbr', bitrateKbpsRaw: number): string[] {
  const mode = modeRaw === 'vbr' ? 'vbr' : 'cbr'
  const bitrateKbps = Math.max(200, Math.min(50000, Math.floor(Number(bitrateKbpsRaw) || 6000)))
  const bitrate = `${bitrateKbps}k`
  const bufsize = `${Math.max(400, bitrateKbps * 2)}k`
  if (mode === 'vbr') {
    const maxrate = `${Math.max(300, Math.round(bitrateKbps * 1.5))}k`
    return ['-b:v', bitrate, '-maxrate', maxrate, '-bufsize', bufsize]
  }
  return ['-b:v', bitrate, '-minrate', bitrate, '-maxrate', bitrate, '-bufsize', bufsize]
}

function buildVideoRateArgs(modeRaw: 'cbr' | 'vbr', bitrateKbpsRaw: number): string[] {
  const mode = modeRaw === 'vbr' ? 'vbr' : 'cbr'
  const base = buildVideoBitrateArgsOnly(modeRaw, bitrateKbpsRaw)
  if (mode === 'vbr') {
    return [...base, '-x264-params', 'force-cfr=1']
  }
  return [...base, '-x264-params', 'nal-hrd=cbr:force-cfr=1']
}

/**
 * Живой RTMP-эфир: на macOS по умолчанию libx264 (стабильнее для тяжёлого filter_complex).
 * VideoToolbox включается явно: `YTGZ_STREAM_VIDEO_CODEC=vt`.
 * Для VT `-realtime 1` включается только явно: `YTGZ_VT_REALTIME=1`.
 * GOP ≈ 2 с: `-g` = 2×fps, `-keyint_min` = fps (YouTube ≤ ~4 с между IDR).
 */
function buildLiveStreamVideoEncodeArgs(
  videoBitrateMode: 'cbr' | 'vbr',
  videoBitrateKbps: number,
  outputFps: number
): string[] {
  const fps = clamp(Math.floor(Number(outputFps) || 30), 12, 120)
  const gop = Math.min(240, Math.max(fps * 2, fps + 1))
  const keyintMin = Math.min(gop, Math.max(12, fps))
  const codecMode = String(process.env.YTGZ_STREAM_VIDEO_CODEC ?? '')
    .trim()
    .toLowerCase()
  const useVideoToolbox =
    process.platform === 'darwin' &&
    (codecMode === 'vt' || codecMode === 'videotoolbox' || codecMode === 'h264_videotoolbox')
  if (useVideoToolbox) {
    const realtime = process.env.YTGZ_VT_REALTIME === '1' ? (['-realtime', '1'] as const) : ([] as const)
    return [
      '-c:v',
      'h264_videotoolbox',
      '-g',
      String(gop),
      '-keyint_min',
      String(keyintMin),
      ...realtime,
      ...buildVideoBitrateArgsOnly(videoBitrateMode, videoBitrateKbps),
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps)
    ]
  }
  return [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-g',
    String(gop),
    '-keyint_min',
    String(keyintMin),
    ...buildVideoRateArgs(videoBitrateMode, videoBitrateKbps),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps)
  ]
}

export function buildFfmpegStreamArgs(input: {
  concatListPath: string
  outputRtmpUrl: string
  overlayPath: string | null
  videoBitrateKbps: number
  videoBitrateMode: 'cbr' | 'vbr'
  extraArgs: string | null
  streamPreviewLayoutJson?: string | null
  streamMusicConcatListPath?: string | null
  streamMusicVolumePercent?: number | null
  concatVideoHasAudio?: boolean | null
  /** 720, 900 или 1080 по ширине; по умолчанию 1080×1920 @ 30 fps. */
  outputWidth?: number | null
  outputHeight?: number | null
  outputFps?: number | null
}): string[] {
  const vo = normalizeStreamVideoOutput({
    stream_output_width: input.outputWidth ?? null,
    stream_output_height: input.outputHeight ?? null,
    stream_video_fps: input.outputFps ?? null
  })
  const cw = vo.width
  const ch = vo.height
  const fps = vo.fps
  const lay = streamCanvasLayoutMetrics(cw, ch)
  let parsedV2: StreamPreviewLayoutV2 | null = null
  if (input.streamPreviewLayoutJson?.trim()) {
    try {
      const parsed = JSON.parse(input.streamPreviewLayoutJson) as StreamPreviewLayoutV2
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.sources)) {
        parsedV2 = parsed
        const gainFromLayout = clamp(Number(parsedV2.mainAudioGainPercent ?? 100), 10, 250)
        const directFromSources = buildFfmpegStreamArgsFromSourcesLayout(
          {
            concatListPath: input.concatListPath,
            outputRtmpUrl: input.outputRtmpUrl,
            overlayPath: input.overlayPath,
            videoBitrateKbps: input.videoBitrateKbps,
            videoBitrateMode: input.videoBitrateMode,
            extraArgs: input.extraArgs,
            outputWidth: cw,
            outputHeight: ch,
            outputFps: fps,
            streamMusicConcatListPath: input.streamMusicConcatListPath ?? null,
            streamMusicVolumePercent: input.streamMusicVolumePercent ?? null,
            concatVideoHasAudio: input.concatVideoHasAudio ?? null,
            mainAudioGainPercent: gainFromLayout
          },
          parsed
        )
        if (directFromSources) return directFromSources
      }
    } catch {
      // fallback to legacy parser
    }
  }

  let overlayPathEffective = input.overlayPath
  let layout = parsePreviewLayout(input.streamPreviewLayoutJson)
  if (parsedV2) {
    const converted = toLegacyLayoutFromSources(parsedV2, input.overlayPath)
    layout = converted.layout
    overlayPathEffective = converted.overlayPath
  }
  const overlayOn = hasOverlay(overlayPathEffective)
  const stageW = 360
  const stageH = 640
  const sx = cw / stageW
  const sy = ch / stageH
  /** Фон: оверлей на весь кадр; «окно» — concat. Вход 0 = concat (-re), вход 1 = loop-оверлей. */
  const bgFull = `[1:v]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch}:(iw-ow)/2:(ih-oh)/2,setsar=1[base]`
  const fgScaled = `[0:v]scale=${lay.segW}:${lay.segH}[fg]`
  const stackOnOverlay = `${bgFull};${fgScaled};[base][fg]overlay=0:${lay.overlayY}:format=auto:eof_action=endall[outvraw];[outvraw]fps=fps=${fps}:round=near,format=yuv420p[outv]`
  /** Без оверлея — запасной вариант с pad (чёрные поля только в этом режиме). */
  const padOnly = `[0:v]scale=${lay.segW}:${lay.segH}[fg];[fg]pad=${cw}:${ch}:0:${lay.overlayY}:black,setsar=1[outvraw];[outvraw]fps=fps=${fps}:round=near,format=yuv420p[outv]`

  let filterComplex: string
  let maps: string[]
  if (layout) {
    const videoScalePct = clamp(toInt(layout.videoScale, 100), 20, 220) / 100
    const overlayScalePct = clamp(toInt(layout.overlayScale, 100), 20, 220) / 100
    const videoW = clamp(Math.round(360 * videoScalePct * sx), 40, 3000)
    const videoH = clamp(Math.round(640 * videoScalePct * sy), 40, 3000)
    const overlayW = clamp(Math.round(336 * overlayScalePct * sx), 40, 3000)
    const overlayH = clamp(Math.round(616 * overlayScalePct * sy), 40, 3000)
    const vx = toInt(layout.video?.x, 0) * sx
    const vy = toInt(layout.video?.y, 0) * sy
    const ox = toInt(layout.overlay?.x, 12) * sx
    const oy = toInt(layout.overlay?.y, 12) * sy

    const videoIn = '0:v'
    const overlayIn = overlayOn ? '1:v' : ''
    const audioMap = '0:a?'
    const chain: string[] = [`color=c=black:s=${cw}x${ch}:r=${fps}[base0]`]
    chain.push(`[${videoIn}]scale=${videoW}:${videoH}:force_original_aspect_ratio=decrease[videoL]`)
    if (overlayOn) {
      chain.push(`[${overlayIn}]scale=${overlayW}:${overlayH}:force_original_aspect_ratio=decrease[overlayL]`)
    }
    const layers: Array<{ key: 'video' | 'overlay'; z: number; label: string; x: number; y: number }> = [
      { key: 'video', z: toInt(layout.videoLayer, 10), label: 'videoL', x: vx, y: vy }
    ]
    if (overlayOn) {
      layers.push({ key: 'overlay', z: toInt(layout.overlayLayer, 20), label: 'overlayL', x: ox, y: oy })
    }
    layers.sort((a, b) => a.z - b.z)
    let cur = 'base0'
    let i = 0
    for (const l of layers) {
      i += 1
      const next = `base${i}`
      chain.push(
        `[${cur}][${l.label}]overlay=${Math.round(l.x)}:${Math.round(l.y)}:format=auto[${next}]`
      )
      cur = next
    }
    const textVisible = layout.text?.visible !== false
    const content = (layout.text?.content ?? '').trim()
    if (textVisible && content) {
      const tx = Math.round(toInt(layout.text?.x, 40) * sx)
      const ty = Math.round(toInt(layout.text?.y, 40) * sy)
      const fontSize = clamp(Math.round(toInt(layout.text?.size, 42) * (sx + sy) / 2), 10, 240)
      const color = (layout.text?.color ?? '#ffffff').replace('#', '')
      const strokeColor = (layout.text?.strokeColor ?? '#000000').replace('#', '')
      const strokeW = clamp(toInt(layout.text?.strokeSize, 2), 0, 16)
      const textEsc = escDrawText(content)
      const fontSpec = pickDrawtextFontSpec(layout.text?.fontFilePath || layout.text?.font)
      const fontPart = `fontfile='${escDrawText(fontSpec.value)}'`
      chain.push(
        `[${cur}]drawtext=text='${textEsc}':${fontPart}:${drawtextShapingPart()}:x=${tx}:y=${ty}:fontcolor=${color}:fontsize=${fontSize}:borderw=${strokeW}:bordercolor=${strokeColor}[outvraw]`
      )
    } else {
      chain.push(`[${cur}]format=yuv420p[outvraw]`)
    }
    filterComplex = `${chain.join(';')};[outvraw]fps=fps=${fps}:round=near,format=yuv420p[outv]`
    maps = ['-map', '[outv]', '-map', audioMap]
  } else if (overlayOn) {
    filterComplex = stackOnOverlay
    maps = ['-map', '[outv]', '-map', '0:a?']
  } else {
    filterComplex = padOnly
    maps = ['-map', '[outv]', '-map', '0:a?']
  }

  const base: string[] = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1']
  const concatListArg = input.concatListPath.trim().replace(/\\/g, '/')
  const overlayFs = (overlayPathEffective ?? '').trim().replace(/\\/g, '/')
  if (overlayOn) {
    base.push(
      ...concatHwDecodePreArgs(),
      '-thread_queue_size',
      '1024',
      '-re',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListArg
    )
    base.push('-thread_queue_size', '256')
    if (isOverlayVideoFile(overlayPathEffective!)) {
      base.push('-stream_loop', '-1', '-i', overlayFs)
    } else {
      base.push('-loop', '1', '-i', overlayFs)
    }
  } else {
    base.push(
      ...concatHwDecodePreArgs(),
      '-thread_queue_size',
      '1024',
      '-re',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListArg
    )
  }
  base.push(
    '-filter_complex',
    filterComplex,
    ...maps,
    ...buildLiveStreamVideoEncodeArgs(input.videoBitrateMode, input.videoBitrateKbps, fps),
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
  videoBitrateKbps: number
  videoBitrateMode: 'cbr' | 'vbr'
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
    ...buildLiveStreamVideoEncodeArgs(input.videoBitrateMode, input.videoBitrateKbps, 30),
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

const BUMPER_MAX_SEC = 24 * 3600

function finalizeBumperSeekAndTarget(durSec: number | null, targetSec: number): { seekSec: number; targetSec: number } {
  const tgt = Math.max(1, Math.min(Math.floor(targetSec), BUMPER_MAX_SEC))
  if (durSec == null || !Number.isFinite(durSec) || durSec <= 0) {
    return { seekSec: 0, targetSec: tgt }
  }
  const d = durSec
  if (tgt >= d) {
    return { seekSec: 0, targetSec: Math.max(1, Math.floor(d)) }
  }
  const span = d - tgt
  const seekSec = Math.random() * span
  return { seekSec: Math.round(seekSec * 1000) / 1000, targetSec: tgt }
}

/**
 * Длительность эфира начальной сцены и случайное смещение в исходнике (новый отрезок на каждый старт стрима).
 */
export function computeBumperPlaybackPlan(input: {
  bumper_pad_target_sec: number | null
  mediaDurationSec: number | null
}): { seekSec: number; targetSec: number } {
  const dur =
    input.mediaDurationSec != null && Number.isFinite(input.mediaDurationSec) && input.mediaDurationSec > 0
      ? input.mediaDurationSec
      : null
  const padCfg = input.bumper_pad_target_sec

  if (padCfg != null && Number.isFinite(padCfg) && padCfg <= 0) {
    const t = dur != null ? dur : 1
    return { seekSec: 0, targetSec: Math.max(1, Math.min(Math.floor(t), BUMPER_MAX_SEC)) }
  }

  if (padCfg != null && Number.isFinite(padCfg) && padCfg > 0) {
    const targetSec = Math.max(1, Math.min(Math.floor(padCfg), BUMPER_MAX_SEC))
    return finalizeBumperSeekAndTarget(dur, targetSec)
  }

  let targetSec = 180
  if (dur != null && dur > 0 && dur < 180) {
    targetSec = Math.max(1, Math.floor(dur))
  }
  return finalizeBumperSeekAndTarget(dur, targetSec)
}

/** Одна вертикальная начальная сцена с диска: случайное окно `targetSec` с позиции `seekSec`, без зацикливания. */
export function buildFfmpegBumperDirectArgs(input: {
  inputFile: string
  outputRtmpUrl: string
  videoBitrateKbps: number
  videoBitrateMode: 'cbr' | 'vbr'
  extraArgs: string | null
  seekSec: number
  targetSec: number
  muteAudio: boolean
  /** Картинка (GIF, PNG, WebP, …) или зацикленное видео поверх (вход 0), ролик начальной сцены — вход 1. */
  overlayPath?: string | null
  /** Фоновая музыка (concat), вход последний. */
  bumperMusicConcatListPath?: string | null
  bumperMusicVolumePercent?: number | null
  bumperVideoHasAudio?: boolean | null
  /** 10–250 % громкости звука ролика начальной сцены (как mainAudioGainPercent в предпросмотре). */
  bumperMainAudioGainPercent?: number | null
  outputWidth?: number | null
  outputHeight?: number | null
  outputFps?: number | null
}): string[] {
  const vo = normalizeStreamVideoOutput({
    stream_output_width: input.outputWidth ?? null,
    stream_output_height: input.outputHeight ?? null,
    stream_video_fps: input.outputFps ?? null
  })
  const cw = vo.width
  const ch = vo.height
  const fps = vo.fps
  const lay = streamCanvasLayoutMetrics(cw, ch)
  const file = input.inputFile.trim().replace(/\\/g, '/')
  const seek = Math.max(0, input.seekSec)
  const tgt = Math.max(1, input.targetSec)
  const bumperVideoGraphOverlay = `${bumperStackOverlayFilter(cw, ch, lay.segW, lay.segH, lay.overlayY)};${bumperVideoTailFps(fps, tgt)}`
  const bumperVideoGraphPad = `${bumperPadOnlyFilter(cw, ch, lay.segW, lay.segH, lay.overlayY)};${bumperVideoTailFps(fps, tgt)}`

  const overlayFs = hasOverlay(input.overlayPath ?? null) ? String(input.overlayPath).trim().replace(/\\/g, '/') : ''
  const musicListRaw = String(input.bumperMusicConcatListPath ?? '').trim()
  const musicOn = Boolean(musicListRaw)
  const musVolLin = clamp(Number(input.bumperMusicVolumePercent ?? 100), 0, 200) / 100
  const mainVolLin = clamp(Number(input.bumperMainAudioGainPercent ?? 100), 10, 250) / 100
  const hasMainA = Boolean(input.bumperVideoHasAudio)

  const base: string[] = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1']

  const hasInfiniteAuxInput = Boolean(overlayFs) || musicOn
  /** Иначе ffmpeg ждёт конца loop-оверлея / loop-музыки и не выходит после `-t` ролика → нет перехода на основной стрим. */
  const shortestArg = hasInfiniteAuxInput ? (['-shortest'] as const) : ([] as const)

  const buildAudioGraphOverlay = (mainIdx: number, musIdx: number): string => {
    if (input.muteAudio && !musicOn) return ''
    if (input.muteAudio && musicOn) {
      return `[${musIdx}:a]atrim=duration=${tgt},asetpts=PTS-STARTPTS,aresample=44100,volume=${musVolLin}[aud]`
    }
    if (!input.muteAudio && musicOn && hasMainA) {
      return `[${mainIdx}:a]volume=${mainVolLin},aresample=44100[va];[${musIdx}:a]atrim=duration=${tgt},asetpts=PTS-STARTPTS,aresample=44100,volume=${musVolLin}[mus];[va][mus]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aud]`
    }
    if (!input.muteAudio && musicOn && !hasMainA) {
      return `[${musIdx}:a]atrim=duration=${tgt},asetpts=PTS-STARTPTS,aresample=44100,volume=${musVolLin}[aud]`
    }
    if (!input.muteAudio && !musicOn && hasMainA) {
      return `[${mainIdx}:a]volume=${mainVolLin},aresample=44100[aud]`
    }
    if (!input.muteAudio && !musicOn && !hasMainA) {
      return `anullsrc=r=44100:cl=stereo,atrim=duration=${tgt},asetpts=N/SR/TB[aud]`
    }
    return ''
  }

  const buildAudioGraphNoOverlay = (mainIdx: number, musIdx: number): string => {
    if (input.muteAudio && !musicOn) return ''
    if (input.muteAudio && musicOn) {
      return `[${musIdx}:a]atrim=duration=${tgt},asetpts=PTS-STARTPTS,aresample=44100,volume=${musVolLin}[aud]`
    }
    if (!input.muteAudio && musicOn && hasMainA) {
      return `[${mainIdx}:a]volume=${mainVolLin},aresample=44100[va];[${musIdx}:a]atrim=duration=${tgt},asetpts=PTS-STARTPTS,aresample=44100,volume=${musVolLin}[mus];[va][mus]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aud]`
    }
    if (!input.muteAudio && musicOn && !hasMainA) {
      return `[${musIdx}:a]atrim=duration=${tgt},asetpts=PTS-STARTPTS,aresample=44100,volume=${musVolLin}[aud]`
    }
    if (!input.muteAudio && !musicOn && hasMainA) {
      return `[${mainIdx}:a]volume=${mainVolLin},aresample=44100[aud]`
    }
    if (!input.muteAudio && !musicOn && !hasMainA) {
      return `anullsrc=r=44100:cl=stereo,atrim=duration=${tgt},asetpts=N/SR/TB[aud]`
    }
    return ''
  }

  if (overlayFs) {
    /** Сначала ролик с `-re` (такт ~1 с/с), затем loop-оверлей — иначе YouTube: «faster than realtime». */
    if (seek > 0) {
      base.push('-ss', String(seek))
    }
    base.push(...concatHwDecodePreArgs())
    base.push('-re', '-i', file)
    base.push('-t', String(tgt))
    if (isOverlayVideoFile(overlayFs)) {
      base.push('-stream_loop', '-1', '-i', overlayFs)
    } else {
      base.push('-loop', '1', '-i', overlayFs)
    }
    if (musicOn) {
      base.push('-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', musicListRaw.replace(/\\/g, '/'))
    }
    const musIdx = 2
    const audioGraph = buildAudioGraphOverlay(0, musIdx)
    if (audioGraph) {
      base.push('-filter_complex', `${bumperVideoGraphOverlay};${audioGraph}`, '-map', '[outv]', '-map', '[aud]')
      base.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100')
    } else {
      base.push('-filter_complex', bumperVideoGraphOverlay, '-map', '[outv]', '-an')
    }
    base.push(
      ...buildLiveStreamVideoEncodeArgs(input.videoBitrateMode, input.videoBitrateKbps, fps),
      ...shortestArg,
      '-f',
      'flv',
      input.outputRtmpUrl
    )
  } else {
    if (seek > 0) {
      base.push('-ss', String(seek))
    }
    base.push(...concatHwDecodePreArgs())
    base.push('-re', '-i', file)
    base.push('-t', String(tgt))
    if (musicOn) {
      base.push('-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', musicListRaw.replace(/\\/g, '/'))
    }
    const musIdx = 1
    const audioGraph = buildAudioGraphNoOverlay(0, musIdx)
    if (audioGraph) {
      base.push('-filter_complex', `${bumperVideoGraphPad};${audioGraph}`, '-map', '[outv]', '-map', '[aud]')
      base.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100')
    } else {
      base.push('-filter_complex', bumperVideoGraphPad, '-map', '[outv]', '-an')
    }
    base.push(
      ...buildLiveStreamVideoEncodeArgs(input.videoBitrateMode, input.videoBitrateKbps, fps),
      ...shortestArg,
      '-f',
      'flv',
      input.outputRtmpUrl
    )
  }

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

/** Начальная сцена только из оверлея (картинка/GIF/видео) + опциональная фоновая музыка. */
export function buildFfmpegBumperOverlayOnlyArgs(input: {
  overlayPath: string
  outputRtmpUrl: string
  videoBitrateKbps: number
  videoBitrateMode: 'cbr' | 'vbr'
  extraArgs: string | null
  targetSec: number
  bumperMusicConcatListPath?: string | null
  bumperMusicVolumePercent?: number | null
  outputWidth?: number | null
  outputHeight?: number | null
  outputFps?: number | null
}): string[] {
  const vo = normalizeStreamVideoOutput({
    stream_output_width: input.outputWidth ?? null,
    stream_output_height: input.outputHeight ?? null,
    stream_video_fps: input.outputFps ?? null
  })
  const cw = vo.width
  const ch = vo.height
  const fps = vo.fps
  const tgt = Math.max(1, Math.floor(Number(input.targetSec) || 180))
  const overlayFs = String(input.overlayPath || '').trim().replace(/\\/g, '/')
  const musicListRaw = String(input.bumperMusicConcatListPath ?? '').trim()
  const musicOn = Boolean(musicListRaw)
  const musVolLin = clamp(Number(input.bumperMusicVolumePercent ?? 100), 0, 200) / 100

  const base: string[] = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1']
  if (isOverlayVideoFile(overlayFs)) {
    base.push('-re', '-stream_loop', '-1', '-i', overlayFs)
  } else {
    base.push('-loop', '1', '-i', overlayFs)
  }
  if (musicOn) {
    base.push('-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', musicListRaw.replace(/\\/g, '/'))
  }

  const videoGraph = `[0:v]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch}:(iw-ow)/2:(ih-oh)/2,setsar=1[outvraw];[outvraw]trim=duration=${tgt},setpts=PTS-STARTPTS[outvp];[outvp]fps=fps=${fps}:round=near,format=yuv420p[outv]`
  const audioGraph = musicOn
    ? `[1:a]atrim=duration=${tgt},asetpts=PTS-STARTPTS,aresample=44100,volume=${musVolLin}[aud]`
    : `anullsrc=r=44100:cl=stereo,atrim=duration=${tgt},asetpts=N/SR/TB[aud]`

  base.push('-filter_complex', `${videoGraph};${audioGraph}`, '-map', '[outv]', '-map', '[aud]')
  base.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100')
  base.push(...buildLiveStreamVideoEncodeArgs(input.videoBitrateMode, input.videoBitrateKbps, fps), '-shortest', '-f', 'flv', input.outputRtmpUrl)

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
  videoBitrateKbps: number
  videoBitrateMode: 'cbr' | 'vbr'
  extraArgs: string | null
  outputWidth?: number | null
  outputHeight?: number | null
  outputFps?: number | null
}): string[] {
  const vo = normalizeStreamVideoOutput({
    stream_output_width: input.outputWidth ?? null,
    stream_output_height: input.outputHeight ?? null,
    stream_video_fps: input.outputFps ?? null
  })
  const cw = vo.width
  const ch = vo.height
  const fps = vo.fps

  const concatVideo = input.concatListPath.trim().replace(/\\/g, '/')
  const concatSfx = input.sfxConcatListPath.trim().replace(/\\/g, '/')
  const concatMusic = input.musicConcatListPath.trim().replace(/\\/g, '/')

  const videoFullVertical = `[0:v]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch}:(iw-ow)/2:(ih-oh)/2,setsar=1[outvraw];[outvraw]fps=fps=${fps}:round=near,format=yuv420p[outv]`
  /** Музыка (вход 2) — ~10% громкости относительно SFX при миксе. */
  const amixBlock =
    `[1:a]aresample=44100[sfxa];[2:a]aresample=44100,volume=0.1[musa];[sfxa][musa]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[aud]`
  const filterComplex = `${videoFullVertical};${amixBlock}`
  const maps = ['-map', '[outv]', '-map', '[aud]']

  const base: string[] = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1']
  base.push('-thread_queue_size', '512', '-re', '-f', 'concat', '-safe', '0', '-i', concatVideo)
  base.push('-thread_queue_size', '512', '-re', '-f', 'concat', '-safe', '0', '-i', concatSfx)
  base.push('-thread_queue_size', '512', '-re', '-f', 'concat', '-safe', '0', '-i', concatMusic)
  base.push(
    '-filter_complex',
    filterComplex,
    ...maps,
    ...buildLiveStreamVideoEncodeArgs(input.videoBitrateMode, input.videoBitrateKbps, fps),
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

/** Предзапечённый main (видео уже с оверлеем/лейаутом): в эфире только видео + (опционально) микс музыки. */
export function buildFfmpegStreamArgsPrebakedMain(input: {
  concatListPath: string
  outputRtmpUrl: string
  videoBitrateKbps: number
  videoBitrateMode: 'cbr' | 'vbr'
  extraArgs: string | null
  streamMusicConcatListPath?: string | null
  streamMusicVolumePercent?: number | null
  mainAudioGainPercent?: number | null
  prebakedVideoHasAudio?: boolean | null
  outputFps?: number | null
}): string[] {
  const fpsRaw = Math.floor(Number(input.outputFps))
  const fps = (STREAM_VIDEO_FPS_OPTIONS as readonly number[]).includes(fpsRaw) ? fpsRaw : 30
  const concatListArg = input.concatListPath.trim().replace(/\\/g, '/')
  const base: string[] = ['-hide_banner', '-loglevel', 'warning', '-stats_period', '1']
  base.push('-thread_queue_size', '1024', '-re', '-f', 'concat', '-safe', '0', '-i', concatListArg)

  const musicListRaw = String(input.streamMusicConcatListPath ?? '').trim()
  const musicOn = Boolean(musicListRaw)
  if (musicOn) {
    base.push('-thread_queue_size', '256', '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', musicListRaw.replace(/\\/g, '/'))
  }

  const hasMainA = Boolean(input.prebakedVideoHasAudio)
  const mainGainLin = clamp(Number(input.mainAudioGainPercent ?? 100), 10, 250) / 100
  const musVolLin = clamp(Number(input.streamMusicVolumePercent ?? 100), 0, 200) / 100

  if (musicOn && hasMainA) {
    const aGraph = `[0:a]volume=${mainGainLin},aresample=44100[va];[1:a]aresample=44100,volume=${musVolLin}[mus];[va][mus]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aud]`
    base.push('-filter_complex', aGraph, '-map', '0:v', '-map', '[aud]')
    base.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100')
  } else if (musicOn && !hasMainA) {
    const aGraph = `[1:a]aresample=44100,volume=${musVolLin}[aud]`
    base.push('-filter_complex', aGraph, '-map', '0:v', '-map', '[aud]')
    base.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100')
  } else if (!musicOn && hasMainA) {
    base.push('-map', '0:v', '-map', '0:a?')
    base.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100')
  } else {
    base.push('-map', '0:v', '-an')
  }

  base.push(...buildLiveStreamVideoEncodeArgs(input.videoBitrateMode, input.videoBitrateKbps, fps), '-f', 'flv', input.outputRtmpUrl)

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
