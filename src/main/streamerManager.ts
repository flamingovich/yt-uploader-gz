import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getChannelById, getProxyById } from '@services/db/queries'
import {
  getStreamerById,
  updateStreamer,
  updateStreamerProcessState,
  updateStreamerViewers
} from '@services/db/streamersQueries'
import { getOAuthClientCredentialsForChannel } from '@services/google/oauthForChannel'
import { startSocksTcpRelay } from '@services/stream/tcpRelaySocks'
import {
  collectBackgroundMusicFiles,
  collectMinecraftPrewarmAudioMp3,
  collectSegmentVideos,
  streamerMultiPassCount,
  unlinkQuiet,
  writeBackgroundMusicShuffledConcatList,
  writeConcatListFileMultiOrderedPasses,
  writeConcatListFileMultiShuffledPasses,
  writeSingleSegmentConcatListMultiPasses,
  writeMinecraftSfxConcatListMultiPasses,
  writeMusicRepeatConcatList
} from '@services/stream/streamerConcat'
import { ffprobeHasAudioStream, getMediaDurationSeconds } from '@services/stream/ffprobe'
import {
  buildFfmpegBumperOverlayOnlyArgs,
  buildFfmpegBumperDirectArgs,
  buildFfmpegStreamArgsPrebakedMain,
  buildFfmpegStreamArgs,
  buildFfmpegStreamArgsMinecraftPrewarm,
  computeBumperPlaybackPlan,
  combineRtmpUrl,
  parseMainAudioGainPercentFromPreviewLayoutJson,
  parsePreviewMusicVolumeFromLayoutJson,
  parseRtmpDestination,
  rewriteRtmpUrlForLocalTunnel,
  spawnFfmpeg
} from '@services/stream/streamerFfmpeg'
import {
  fetchLiveBroadcastConcurrentViewers,
  suggestLiveBroadcastId
} from '@services/youtube/liveBroadcast'
import type { ProxyRow, StreamerRow } from '@services/db/types'
import { resolveAppIconPath } from './appIcon'

function isMinecraftPrewarmOn(row: StreamerRow): boolean {
  return Number(row.minecraft_prewarm_enabled) === 1
}

function getStreamMode(row: StreamerRow): 'random' | 'ordered' | 'single' {
  if (row.stream_type === 'white_prewarm') return 'single'
  return row.stream_mode === 'ordered' || row.stream_mode === 'single' ? row.stream_mode : 'random'
}

function extensionFromDataImageMime(mime: string): string {
  const m = mime.toLowerCase()
  if (m === 'image/gif') return '.gif'
  if (m === 'image/png') return '.png'
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg'
  if (m === 'image/webp') return '.webp'
  if (m === 'image/bmp') return '.bmp'
  if (m === 'image/avif') return '.avif'
  if (m === 'image/heic' || m === 'image/heif') return '.heic'
  if (m === 'image/tiff') return '.tiff'
  return '.img'
}

async function materializeLayoutDataUrlSourcesForLive(layoutJson: string): Promise<{ layoutJson: string; tempFiles: string[] }> {
  if (!layoutJson.trim()) return { layoutJson, tempFiles: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(layoutJson)
  } catch {
    return { layoutJson, tempFiles: [] }
  }
  if (!parsed || typeof parsed !== 'object') return { layoutJson, tempFiles: [] }
  const obj = parsed as { sources?: Array<Record<string, unknown>> }
  if (!Array.isArray(obj.sources) || obj.sources.length < 1) return { layoutJson, tempFiles: [] }

  const tempFiles: string[] = []
  for (const source of obj.sources) {
    if (!source || typeof source !== 'object') continue
    const type = String(source.type ?? '')
    if (type !== 'gif' && type !== 'image' && type !== 'overlay') continue
    const src = String(source.src ?? '').trim()
    if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(src)) continue
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(src)
    if (!match) continue
    const mime = String(match[1] || 'image/png')
    const b64 = String(match[2] || '')
    if (!b64) continue
    const ext = extensionFromDataImageMime(mime)
    const tempPath = join(tmpdir(), `ytu-live-src-${Date.now()}-${randomBytes(6).toString('hex')}${ext}`)
    await fsp.writeFile(tempPath, Buffer.from(b64, 'base64'))
    source.filePath = tempPath
    source.src = tempPath
    tempFiles.push(tempPath)
  }
  return { layoutJson: JSON.stringify(obj), tempFiles }
}

type CreateOk = { ok: true }
type CreateErr = { ok: false; error: string }
type CreateResult = CreateOk | CreateErr

type Session = {
  stopRequested: boolean
  closeRelay: (() => Promise<void>) | null
  ffmpeg: ChildProcess | null
  viewerTimer: ReturnType<typeof setInterval> | null
  /** Последний суммарный битрейт из строки прогресса ffmpeg (kbits/s). */
  videoBitrateKbps: number | null
  /** RTMP-туннель через SOCKS поднят (иначе прямой выход ffmpeg). */
  usedProxy: boolean
}

type PrebakeStatus = {
  phase: 'idle' | 'running' | 'done' | 'error'
  percent: number
  message: string
  outputPath: string | null
  cacheHit: boolean
  updatedAt: number
}

const DEBUG_FFMPEG = process.env.YTGZ_DEBUG_FFMPEG === '1'
const STREAM_CONSOLE_MAX_LINES = 5000
let streamConsoleWindow: BrowserWindow | null = null
const streamConsoleLines: string[] = []

const sessions = new Map<number, Session>()
const prebakeStatusByStreamer = new Map<number, PrebakeStatus>()
const prebakeTaskByStreamer = new Map<number, Promise<void>>()
const prebakeProcByStreamer = new Map<number, ChildProcess>()
const prebakeCancelRequested = new Set<number>()
const prebakeOutPathByStreamer = new Map<number, string>()

function setPrebakeStatus(streamerId: number, next: Partial<PrebakeStatus>): void {
  const prev =
    prebakeStatusByStreamer.get(streamerId) ??
    ({
      phase: 'idle',
      percent: 0,
      message: '',
      outputPath: null,
      cacheHit: false,
      updatedAt: Date.now()
    } satisfies PrebakeStatus)
  prebakeStatusByStreamer.set(streamerId, { ...prev, ...next, updatedAt: Date.now() })
}

function appendStreamConsoleLine(lineRaw: string): void {
  const line = String(lineRaw || '').trim()
  if (!line) return
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const full = `${ts} ${line}`
  streamConsoleLines.push(full)
  if (streamConsoleLines.length > STREAM_CONSOLE_MAX_LINES) {
    streamConsoleLines.splice(0, streamConsoleLines.length - STREAM_CONSOLE_MAX_LINES)
  }
  const win = streamConsoleWindow
  if (!win || win.isDestroyed()) return
  const js = `window.__appendLiveLog && window.__appendLiveLog(${JSON.stringify(full)});`
  void win.webContents.executeJavaScript(js, true).catch(() => {})
}

export async function openStreamRuntimeConsoleWindow(): Promise<void> {
  if (streamConsoleWindow && !streamConsoleWindow.isDestroyed()) {
    streamConsoleWindow.show()
    streamConsoleWindow.focus()
    return
  }
  const icon = resolveAppIconPath()
  const win = new BrowserWindow({
    width: 980,
    height: 620,
    minWidth: 760,
    minHeight: 420,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  streamConsoleWindow = win
  win.on('closed', () => {
    if (streamConsoleWindow === win) streamConsoleWindow = null
  })
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Консоль трансляции</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; background: #0b0d10; color: #d9dee7; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      .top { display: flex; gap: 8px; align-items: center; padding: 10px; border-bottom: 1px solid #232933; background: #121722; }
      .title { font: 600 12px/1.2 Inter, system-ui, sans-serif; color: #c9d2df; margin-right: auto; }
      button { border: 1px solid #2d3644; background: #171d29; color: #d9dee7; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
      button:hover { border-color: #4a5b72; }
      .muted { color: #8f9db1; font: 11px/1.2 Inter, system-ui, sans-serif; }
      #log { height: calc(100vh - 56px); overflow: auto; padding: 10px; white-space: pre-wrap; word-break: break-word; }
    </style>
  </head>
  <body>
    <div class="top">
      <div class="title">Консоль состояния трансляции</div>
      <button id="copyBtn" type="button">Копировать всё</button>
      <button id="clearBtn" type="button">Очистить</button>
      <label class="muted"><input id="autoScroll" type="checkbox" checked /> auto-scroll</label>
    </div>
    <div id="log"></div>
    <script>
      const logEl = document.getElementById('log')
      const autoScrollEl = document.getElementById('autoScroll')
      function appendLine(line) {
        const atBottom = Math.abs(logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight) < 16
        logEl.textContent += (logEl.textContent ? '\\n' : '') + String(line || '')
        if ((autoScrollEl && autoScrollEl.checked) || atBottom) logEl.scrollTop = logEl.scrollHeight
      }
      window.__appendLiveLog = appendLine
      document.getElementById('copyBtn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(logEl.textContent || '')
        } catch {
          const ta = document.createElement('textarea')
          ta.value = logEl.textContent || ''
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
      })
      document.getElementById('clearBtn').addEventListener('click', () => {
        logEl.textContent = ''
      })
    </script>
  </body>
</html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const initial = streamConsoleLines.join('\n')
  void win.webContents.executeJavaScript(
    `(() => { const n = document.getElementById('log'); if (n) { n.textContent = ${JSON.stringify(initial)}; n.scrollTop = n.scrollHeight; } })();`,
    true
  )
}

function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(arg)) return arg
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function redactFfmpegArg(arg: string): string {
  if (!/^rtmps?:\/\//i.test(arg)) return arg
  try {
    const u = new URL(arg)
    if (u.password) u.password = '***'
    if (u.username) u.username = '***'
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length > 0) {
      parts[parts.length - 1] = '***'
      u.pathname = `/${parts.join('/')}`
    }
    return u.toString()
  } catch {
    return arg.replace(/\/[^/]*$/, '/***')
  }
}

function logFfmpegCommand(args: string[]): void {
  const shouldMirror = Boolean(streamConsoleWindow && !streamConsoleWindow.isDestroyed())
  if (!DEBUG_FFMPEG && !shouldMirror) return
  const safe = args.map(redactFfmpegArg).map(shellQuoteArg).join(' ')
  const msg = `[FFMPEG CMD] ffmpeg ${safe}`
  if (DEBUG_FFMPEG) console.info(msg)
  appendStreamConsoleLine(msg)
}

function parseLastFfmpegStatNumber(buf: string, key: 'fps' | 'speed'): number | null {
  const tail = buf.slice(-6000)
  const re = key === 'fps' ? /fps=\s*([\d.]+)/gi : /speed=\s*([\d.]+)x/gi
  let last: number | null = null
  for (;;) {
    const m = re.exec(tail)
    if (!m) break
    const n = Number.parseFloat(m[1]!)
    if (Number.isFinite(n)) last = n
  }
  return last
}

function withFfmpegProgressFile(args: string[], progressPath: string): string[] {
  const p = progressPath.replace(/\\/g, '/')
  const idx = args.findIndex((a, i) => a === '-stats_period' && args[i + 1] !== undefined)
  if (idx !== -1) {
    return [...args.slice(0, idx + 2), '-progress', p, ...args.slice(idx + 2)]
  }
  return ['-progress', p, ...args]
}

function lastBitrateKbpsFromProgressFileText(text: string): number | null {
  let last: number | null = null
  for (const line of text.split('\n')) {
    const m = /^bitrate=(.+)$/i.exec(line.trim())
    if (!m) continue
    const v = m[1]!.trim()
    if (v === 'N/A' || v === 'nan' || v === '') continue
    const n = Number.parseFloat(v)
    if (Number.isFinite(n)) last = n
  }
  return last
}

function parseProgressSnapshot(text: string): {
  bitrateKbps: number | null
  fps: number | null
  speed: number | null
  outTimeUs: number | null
  progress: string | null
} {
  let bitrateKbps: number | null = null
  let fps: number | null = null
  let speed: number | null = null
  let outTimeUs: number | null = null
  let progress: string | null = null
  for (const lineRaw of text.split('\n')) {
    const line = lineRaw.trim()
    if (!line) continue
    const m = /^([^=]+)=(.*)$/.exec(line)
    if (!m) continue
    const k = m[1]!.trim()
    const v = m[2]!.trim()
    if (k === 'bitrate') {
      if (v !== 'N/A' && v !== 'nan' && v !== '') {
        const n = Number.parseFloat(v)
        if (Number.isFinite(n)) bitrateKbps = n
      }
    } else if (k === 'fps') {
      const n = Number.parseFloat(v)
      if (Number.isFinite(n)) fps = n
    } else if (k === 'speed') {
      const n = Number.parseFloat(v.replace(/x$/i, ''))
      if (Number.isFinite(n)) speed = n
    } else if (k === 'out_time_us') {
      const n = Number.parseInt(v, 10)
      if (Number.isFinite(n)) outTimeUs = n
    } else if (k === 'progress') {
      progress = v || null
    }
  }
  return { bitrateKbps, fps, speed, outTimeUs, progress }
}

function stripRealtimeInputArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const v = args[i]!
    if (v === '-re') continue
    out.push(v)
  }
  return out
}

function toMp4FileArgs(streamArgs: string[], outputFile: string, durationSec: number): string[] {
  const args = stripRealtimeInputArgs(streamArgs)
  const flvIdx = args.lastIndexOf('-f')
  if (flvIdx < 0 || flvIdx + 1 >= args.length) {
    throw new Error('Не удалось подготовить ffmpeg args для pre-bake')
  }
  args.splice(flvIdx, args.length - flvIdx, '-t', String(durationSec), '-movflags', '+faststart', '-f', 'mp4', outputFile)
  return args
}

function getMainPrebakeCacheDir(): string {
  const dir = join(app.getPath('userData'), 'stream-main-prebake-cache')
  mkdirSync(dir, { recursive: true })
  return dir
}

function fileStamp(p: string | null): string {
  if (!p) return 'none'
  try {
    const st = statSync(p)
    return `${p}|${st.size}|${Math.floor(st.mtimeMs)}`
  } catch {
    return `${p}|missing`
  }
}

function calcMainPrebakeKey(input: {
  videoPath: string
  overlayPath: string | null
  layoutJson: string
  outputWidth: number
  outputHeight: number
  outputFps: number
  bitrateKbps: number
}): string {
  const h = createHash('sha1')
  h.update(fileStamp(input.videoPath))
  h.update('\n')
  h.update(fileStamp(input.overlayPath))
  h.update('\n')
  h.update(input.layoutJson || '')
  h.update(`\n${input.outputWidth}x${input.outputHeight}@${input.outputFps}`)
  h.update(`\n${input.bitrateKbps}`)
  return h.digest('hex')
}

function getMainPrebakeOutputPath(input: {
  videoPath: string
  overlayPath: string | null
  layoutJson: string
  outputWidth: number
  outputHeight: number
  outputFps: number
  bitrateKbps: number
}): string {
  const key = calcMainPrebakeKey(input)
  return join(getMainPrebakeCacheDir(), `main-prebaked-${key}.mp4`)
}

async function runFfmpegPrebakeWithProgress(input: {
  streamerId: number
  args: string[]
  totalSec: number
  touchStreamerState?: boolean
  onProgress?: (p: { percent: number; speedText: string; fpsText: string; bitrateText: string; message: string }) => void
}): Promise<{ code: number | null; stderr: string }> {
  const progressPath = join(tmpdir(), `ffp-prebake-${randomBytes(8).toString('hex')}.txt`)
  const argsWithProgress = withFfmpegProgressFile(input.args, progressPath)
  logFfmpegCommand(argsWithProgress)
  const proc = spawnFfmpeg(argsWithProgress)
  prebakeProcByStreamer.set(input.streamerId, proc)
  let stderrBuf = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-12000)
  })
  let lastPercent = -1
  const tick = (): void => {
    try {
      const txt = readFileSync(progressPath, 'utf8')
      const snap = parseProgressSnapshot(txt)
      const outSec = snap.outTimeUs != null ? Math.max(0, snap.outTimeUs / 1_000_000) : 0
      const percent = Math.max(0, Math.min(100, Math.floor((outSec / Math.max(1, input.totalSec)) * 100)))
      if (percent !== lastPercent) {
        lastPercent = percent
        const speedText = snap.speed != null ? snap.speed.toFixed(2) : '?'
        const fpsText = snap.fps != null ? snap.fps.toFixed(1) : '?'
        const brText = snap.bitrateKbps != null ? `${Math.round(snap.bitrateKbps)}k` : '?'
        const msg = `Pre-bake main: ${percent}% (speed=${speedText}x fps=${fpsText} bitrate=${brText})`
        if (input.touchStreamerState !== false) {
          updateStreamerProcessState(input.streamerId, 'starting', msg)
        }
        input.onProgress?.({ percent, speedText, fpsText, bitrateText: brText, message: msg })
        appendStreamConsoleLine(`[PREBAKE] ${msg}`)
      }
    } catch {
      // ignore
    }
  }
  const timer = setInterval(tick, 700)
  tick()
  const code = await new Promise<number | null>((resolvePromise) => {
    proc.once('error', () => resolvePromise(null))
    proc.once('close', (c) => resolvePromise(c))
  })
  clearInterval(timer)
  try {
    unlinkSync(progressPath)
  } catch {
    // ignore
  }
  prebakeProcByStreamer.delete(input.streamerId)
  return { code, stderr: stderrBuf.trim() }
}

function lastBitrateKbpsFromFfmpegStderr(buf: string): number | null {
  const tail = buf.slice(-4000)
  let last: number | null = null
  const re = /bitrate=\s*([\d.]+)\s*(k|m)?bits\/s/gi
  for (;;) {
    const m = re.exec(tail)
    if (!m) break
    const v = Number.parseFloat(m[1]!)
    if (!Number.isFinite(v)) continue
    const mult = m[2]?.toLowerCase() === 'm' ? 1000 : 1
    last = v * mult
  }
  return last
}

function appendStderrAndParseBitrate(
  chunk: string,
  session: Session,
  phase: 'bumper' | 'main',
  lastStderrRef: { s: string; lastStatAt: number }
): void {
  lastStderrRef.s = (lastStderrRef.s + chunk).slice(-7000)
  const kbps = lastBitrateKbpsFromFfmpegStderr(lastStderrRef.s)
  if (kbps != null) session.videoBitrateKbps = kbps
  const shouldMirror = Boolean(streamConsoleWindow && !streamConsoleWindow.isDestroyed())
  if (!DEBUG_FFMPEG && !shouldMirror) return
  const speed = parseLastFfmpegStatNumber(lastStderrRef.s, 'speed')
  const fps = parseLastFfmpegStatNumber(lastStderrRef.s, 'fps')
  if (speed != null) {
    const now = Date.now()
    if (now - lastStderrRef.lastStatAt < 1200 && speed >= 0.98) return
    lastStderrRef.lastStatAt = now
    const sp = speed.toFixed(2)
    const fp = fps != null ? fps.toFixed(1) : '?'
    const br = kbps != null ? Math.round(kbps) : session.videoBitrateKbps != null ? Math.round(session.videoBitrateKbps) : null
    const brText = br != null ? `${br}k` : '?'
    const phaseTag = phase === 'bumper' ? 'BUMPER' : 'MAIN'
    if (speed < 0.98) {
      const msg = `[FFMPEG PERF][${phaseTag}] slow pipeline: speed=${sp}x fps=${fp} bitrate=${brText}`
      if (DEBUG_FFMPEG) console.warn(msg)
      appendStreamConsoleLine(msg)
    } else {
      const msg = `[FFMPEG STAT][${phaseTag}] speed=${sp}x fps=${fp} bitrate=${brText}`
      if (DEBUG_FFMPEG) console.info(msg)
      appendStreamConsoleLine(msg)
    }
  }
  if (chunk.includes('Thread message queue blocking')) {
    const msg = '[FFMPEG QUEUE] Thread message queue blocking detected'
    if (DEBUG_FFMPEG) console.warn(msg)
    appendStreamConsoleLine(msg)
  }
}

async function runFfmpegWithCapturedStderr(
  args: string[],
  session: Session,
  phase: 'bumper' | 'main'
): Promise<{ code: number | null; stderr: string }> {
  const progressPath = join(tmpdir(), `ffp-${randomBytes(8).toString('hex')}.txt`)
  const argsWithProgress = withFfmpegProgressFile(args, progressPath)
  logFfmpegCommand(argsWithProgress)
  let proc: ChildProcess
  try {
    proc = spawnFfmpeg(argsWithProgress)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Не удалось запустить ffmpeg')
  }

  session.ffmpeg = proc
  session.videoBitrateKbps = null
  const lastStderrRef = { s: '', lastStatAt: 0 }
  let lastProgressStatAt = 0
  let lastOutTimeUs: number | null = null
  let lastOutTimeAt = 0
  proc.stderr?.on('data', (chunk: Buffer) => {
    appendStderrAndParseBitrate(chunk.toString('utf8'), session, phase, lastStderrRef)
  })

  const tickProgress = (): void => {
    try {
      const txt = readFileSync(progressPath, 'utf8')
      const snap = parseProgressSnapshot(txt)
      const kbps = snap.bitrateKbps ?? lastBitrateKbpsFromProgressFileText(txt)
      if (kbps != null) session.videoBitrateKbps = kbps
      const shouldMirror = Boolean(streamConsoleWindow && !streamConsoleWindow.isDestroyed())
      if (DEBUG_FFMPEG || shouldMirror) {
        const now = Date.now()
        if (snap.outTimeUs != null) {
          if (lastOutTimeUs == null || snap.outTimeUs > lastOutTimeUs) {
            lastOutTimeUs = snap.outTimeUs
            lastOutTimeAt = now
          } else if (snap.progress === 'continue' && lastOutTimeAt > 0 && now - lastOutTimeAt > 5000) {
            appendStreamConsoleLine('[FFMPEG STALL] out_time_us is not moving for >5s (possible network/output stall)')
            lastOutTimeAt = now
          }
        }
        if (now - lastProgressStatAt >= 1200) {
          const phaseTag = phase === 'bumper' ? 'BUMPER' : 'MAIN'
          const sp = snap.speed != null ? snap.speed.toFixed(2) : '?'
          const fp = snap.fps != null ? snap.fps.toFixed(1) : '?'
          const br = session.videoBitrateKbps != null ? `${Math.round(session.videoBitrateKbps)}k` : '?'
          const msg = `[FFMPEG PROGRESS][${phaseTag}] speed=${sp}x fps=${fp} bitrate=${br}`
          appendStreamConsoleLine(msg)
          lastProgressStatAt = now
        }
      }
    } catch {
      /* файл ещё не создан */
    }
  }
  const tmr = setInterval(tickProgress, 550)
  tickProgress()

  const code = await new Promise<number | null>((resolvePromise) => {
    proc.once('error', () => resolvePromise(null))
    proc.once('close', (c) => resolvePromise(c))
  })
  clearInterval(tmr)
  try {
    unlinkSync(progressPath)
  } catch {
    /* ignore */
  }
  session.ffmpeg = null
  await killProcessTree(proc.pid)
  return { code, stderr: lastStderrRef.s.trim() }
}

function resolveStreamerProxy(row: StreamerRow): ProxyRow | undefined {
  if (row.proxy_id) {
    const p = getProxyById(row.proxy_id)
    if (!p) throw new Error('Прокси стримера не найден')
    return p
  }
  const ch = getChannelById(row.channel_id)
  if (ch?.proxy_id) {
    const p = getProxyById(ch.proxy_id)
    return p ?? undefined
  }
  return undefined
}

function hasSocksProxyConfigured(row: StreamerRow): boolean {
  return resolveStreamerProxy(row) != null
}

async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid || pid < 1) return
  await new Promise<void>((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* ignore */
        }
      }
      resolve()
    }
  })
}

function restartViewerPolling(
  session: Session,
  streamerId: number,
  broadcastId: string | null,
  channelId: number
): void {
  if (session.viewerTimer) {
    clearInterval(session.viewerTimer)
    session.viewerTimer = null
  }
  const b = broadcastId?.trim()
  if (b) {
    session.viewerTimer = startViewerPolling(streamerId, b, channelId)
  }
}

/** Подставить актуальный Broadcast ID с YouTube и обновить опрос зрителей. */
async function syncYoutubeBroadcastId(streamerId: number, session: Session | null): Promise<void> {
  const row = getStreamerById(streamerId)
  if (!row?.channel_id) return
  const ch = getChannelById(row.channel_id)
  if (!ch?.oauth_refresh_token?.trim()) return
  let effectiveId: string | null = row.youtube_broadcast_id?.trim() || null
  try {
    const creds = getOAuthClientCredentialsForChannel(row.channel_id)
    const hit = await suggestLiveBroadcastId({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.channel.oauth_refresh_token!,
      accessToken: creds.channel.oauth_access_token,
      proxy: creds.proxy ?? null
    })
    if (hit?.broadcastId) {
      const prev = (row.youtube_broadcast_id ?? '').trim()
      if (prev !== hit.broadcastId) {
        updateStreamer(streamerId, { youtube_broadcast_id: hit.broadcastId })
      }
      effectiveId = hit.broadcastId
    }
  } catch {
    /* не блокируем эфир */
  }
  if (session) {
    restartViewerPolling(session, streamerId, effectiveId, row.channel_id)
  }
}

function startViewerPolling(streamerId: number, broadcastId: string, channelId: number): ReturnType<typeof setInterval> {
  const tick = (): void => {
    void (async () => {
      try {
        const creds = getOAuthClientCredentialsForChannel(channelId)
        if (!creds.channel.oauth_refresh_token) return
        const n = await fetchLiveBroadcastConcurrentViewers({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          refreshToken: creds.channel.oauth_refresh_token,
          accessToken: creds.channel.oauth_access_token,
          proxy: creds.proxy ?? null,
          broadcastId
        })
        updateStreamerViewers(streamerId, n)
      } catch {
        /* ignore quota / scope errors */
      }
    })()
  }
  tick()
  return setInterval(tick, 15 * 60 * 1000)
}

async function ensureSingleMainPrebake(input: {
  streamerId: number
  sourceVideoPath: string
  overlayPath: string | null
  layoutJson: string
  outputWidth: number
  outputHeight: number
  outputFps: number
  videoBitrateKbps: number
  videoBitrateMode: 'cbr' | 'vbr'
  extraArgs: string | null
  concatVideoHasAudio: boolean
  touchStreamerState?: boolean
  forceRebuild?: boolean
  onProgress?: (p: { percent: number; message: string; speedText: string; fpsText: string; bitrateText: string }) => void
}): Promise<{ prebakedPath: string; hasAudio: boolean; cacheHit: boolean }> {
  if (process.env.YTGZ_MAIN_PREBAKE === '0') {
    appendStreamConsoleLine('[PREBAKE] disabled by YTGZ_MAIN_PREBAKE=0')
    return { prebakedPath: input.sourceVideoPath, hasAudio: input.concatVideoHasAudio, cacheHit: true }
  }
  const cacheDir = getMainPrebakeCacheDir()
  const key = calcMainPrebakeKey({
    videoPath: input.sourceVideoPath,
    overlayPath: input.overlayPath,
    layoutJson: input.layoutJson,
    outputWidth: input.outputWidth,
    outputHeight: input.outputHeight,
    outputFps: input.outputFps,
    bitrateKbps: input.videoBitrateKbps
  })
  const outPath = join(cacheDir, `main-prebaked-${key}.mp4`)
  const exists = existsSync(outPath)
  appendStreamConsoleLine(`[PREBAKE] video source: ${existsSync(input.sourceVideoPath) ? 'ready' : 'missing'}`)
  appendStreamConsoleLine(`[PREBAKE] overlay source: ${input.overlayPath ? (existsSync(input.overlayPath) ? 'ready' : 'missing') : 'none'}`)
  if (exists && !input.forceRebuild) {
    appendStreamConsoleLine(`[PREBAKE] cache hit: ${outPath}`)
    let outHasAudio = false
    try {
      outHasAudio = await ffprobeHasAudioStream(outPath)
    } catch {
      outHasAudio = false
    }
    return { prebakedPath: outPath, hasAudio: outHasAudio, cacheHit: true }
  }
  if (exists && input.forceRebuild) {
    appendStreamConsoleLine('[PREBAKE] force rebuild requested, ignoring cache')
    try {
      unlinkSync(outPath)
    } catch {
      // ignore
    }
  }

  appendStreamConsoleLine('[PREBAKE] cache miss: rendering main scene')
  if (input.touchStreamerState !== false) {
    updateStreamerProcessState(input.streamerId, 'starting', 'Pre-bake main сцены: 0%')
  }
  const oneListPath = join(tmpdir(), `ytu-one-${randomBytes(8).toString('hex')}.txt`)
  writeFileSync(oneListPath, `file '${input.sourceVideoPath.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'\n`, 'utf8')
  const dummyRtmp = 'rtmp://127.0.0.1/live/prebake-main'
  const streamArgs = buildFfmpegStreamArgs({
    concatListPath: oneListPath,
    outputRtmpUrl: dummyRtmp,
    overlayPath: input.overlayPath,
    videoBitrateKbps: Math.max(500, Math.floor(input.videoBitrateKbps)),
    videoBitrateMode: input.videoBitrateMode,
    extraArgs: input.extraArgs,
    streamPreviewLayoutJson: input.layoutJson,
    streamMusicConcatListPath: null,
    streamMusicVolumePercent: null,
    concatVideoHasAudio: input.concatVideoHasAudio,
    outputWidth: input.outputWidth,
    outputHeight: input.outputHeight,
    outputFps: input.outputFps
  })
  const dur = Math.max(1, Math.floor(await getMediaDurationSeconds(input.sourceVideoPath)))
  const renderArgs = toMp4FileArgs(streamArgs, outPath, dur)
  prebakeOutPathByStreamer.set(input.streamerId, outPath)
  try {
    const out = await runFfmpegPrebakeWithProgress({
      streamerId: input.streamerId,
      args: renderArgs,
      totalSec: dur,
      touchStreamerState: input.touchStreamerState,
      onProgress: input.onProgress
    })
    if (prebakeCancelRequested.has(input.streamerId)) {
      throw new Error('__PREBAKE_CANCELLED__')
    }
    if (out.code !== 0 || !existsSync(outPath)) {
      throw new Error(`pre-bake ffmpeg failed: ${out.stderr || `exit ${String(out.code)}`}`)
    }
    let outHasAudio = false
    try {
      outHasAudio = await ffprobeHasAudioStream(outPath)
    } catch {
      outHasAudio = false
    }
    appendStreamConsoleLine(`[PREBAKE] done: ${outPath}`)
    return { prebakedPath: outPath, hasAudio: outHasAudio, cacheHit: false }
  } finally {
    prebakeOutPathByStreamer.delete(input.streamerId)
    await unlinkQuiet(oneListPath)
  }
}

async function runStreamerLoop(streamerId: number, session: Session): Promise<void> {
  const first = getStreamerById(streamerId)
  if (!first) return

  let combined: string
  try {
    combined = combineRtmpUrl(first.rtmp_ingest_url, first.rtmp_stream_key)
  } catch (e) {
    updateStreamerProcessState(streamerId, 'error', e instanceof Error ? e.message : 'RTMP')
    return
  }

  let outputRtmpUrl = combined
  try {
    const proxy = resolveStreamerProxy(first)
    if (proxy) {
      const dest = parseRtmpDestination(combined)
      const relay = await startSocksTcpRelay({
        proxy,
        destHost: dest.host,
        destPort: dest.port
      })
      session.closeRelay = relay.close
      session.usedProxy = true
      outputRtmpUrl = rewriteRtmpUrlForLocalTunnel(combined, relay.localPort)
    }
  } catch (e) {
    updateStreamerProcessState(
      streamerId,
      'error',
      e instanceof Error ? e.message : 'Прокси / RTMP туннель'
    )
    return
  }

  /** Важный момент: pre-bake main делаем ДО выхода в эфир, чтобы не рвать RTMP между bumper и main. */
  let prewarmedSingleMainPath: string | null = null
  let prewarmedSingleMainHasAudio: boolean | null = null
  try {
    const firstMode = getStreamMode(first)
    const canPrewarmBeforeLive =
      firstMode === 'single' &&
      first.stream_type !== 'white_prewarm' &&
      Boolean(first.single_segment_path?.trim()) &&
      Boolean(first.overlay_path?.trim())
    if (canPrewarmBeforeLive) {
      const srcVideo = resolve(first.single_segment_path!.trim())
      const srcOverlay = resolve(first.overlay_path!.trim())
      const chLayout = getChannelById(first.channel_id)
      const layoutRaw = chLayout?.stream_preview_layout_json ?? ''
      const hydrated = await materializeLayoutDataUrlSourcesForLive(layoutRaw)
      try {
        const prebakePath = getMainPrebakeOutputPath({
          videoPath: srcVideo,
          overlayPath: srcOverlay,
          layoutJson: hydrated.layoutJson || '',
          outputWidth: first.stream_output_width,
          outputHeight: first.stream_output_height,
          outputFps: first.stream_video_fps,
          bitrateKbps: first.video_bitrate_kbps
        })
        if (existsSync(prebakePath)) {
          let validCache = true
          try {
            const d = await getMediaDurationSeconds(prebakePath)
            if (!Number.isFinite(d) || d < 30) validCache = false
          } catch {
            validCache = false
          }
          if (!validCache) {
            appendStreamConsoleLine('[PREBAKE] cache file invalid, ignoring and fallback to live graph')
            await unlinkQuiet(prebakePath)
          } else {
          let preHasAudio = false
          try {
            preHasAudio = await ffprobeHasAudioStream(prebakePath)
          } catch {
            preHasAudio = false
          }
          prewarmedSingleMainPath = prebakePath
          prewarmedSingleMainHasAudio = preHasAudio
          appendStreamConsoleLine('[PREBAKE] cache hit before live start')
          }
        } else {
          appendStreamConsoleLine('[PREBAKE] cache not found for current params; use "Pre-bake main" button')
        }
      } finally {
        for (const p of hydrated.tempFiles) {
          await unlinkQuiet(p)
        }
      }
    }
  } catch (e) {
    appendStreamConsoleLine(`[PREBAKE] prewarm failed, fallback to live graph: ${e instanceof Error ? e.message : String(e)}`)
  }

  const bumperVideoRaw = first.bumper_video_path?.trim() ?? ''
  const bumperOverlayRaw = first.bumper_overlay_path?.trim() ?? ''
  if (first.stream_type !== 'white_prewarm' && (bumperVideoRaw || bumperOverlayRaw)) {
    try {
      const bumperFs = bumperVideoRaw ? resolve(bumperVideoRaw) : null
      const bumperOverlayFs = bumperOverlayRaw ? resolve(bumperOverlayRaw) : null
      const durSec = bumperFs ? await getMediaDurationSeconds(bumperFs) : null
      const plan = computeBumperPlaybackPlan({ bumper_pad_target_sec: first.bumper_pad_target_sec, mediaDurationSec: durSec })
      let bumperMusicListPath: string | null = null
      try {
        const musDir = first.bumper_music_folder_path?.trim()
        if (musDir) {
          const tracks = await collectBackgroundMusicFiles(musDir)
          if (tracks.length > 0) {
            bumperMusicListPath = await writeBackgroundMusicShuffledConcatList({ audioPaths: tracks, repeatBlocks: 24 })
          }
        }
      } catch {
        bumperMusicListPath = null
      }
      const chBumper = getChannelById(first.channel_id)
      const bumperMainGain = parseMainAudioGainPercentFromPreviewLayoutJson(chBumper?.stream_preview_bumper_layout_json ?? null)
      const bumperMusicVol =
        parsePreviewMusicVolumeFromLayoutJson(chBumper?.stream_preview_bumper_layout_json ?? '') ??
        Number(first.bumper_music_volume ?? 100)
      const bumperArgs = bumperFs
        ? await (async () => {
            let bumperHasAudio = false
            try {
              bumperHasAudio = await ffprobeHasAudioStream(bumperFs)
            } catch {
              bumperHasAudio = false
            }
            return buildFfmpegBumperDirectArgs({
              inputFile: bumperFs,
              outputRtmpUrl,
              videoBitrateKbps: first.video_bitrate_kbps,
              videoBitrateMode: first.video_bitrate_mode,
              extraArgs: first.ffmpeg_extra_args,
              seekSec: plan.seekSec,
              targetSec: plan.targetSec,
              muteAudio: first.bumper_mute_audio === 1,
              overlayPath: bumperOverlayFs,
              bumperMusicConcatListPath: bumperMusicListPath,
              bumperMusicVolumePercent: bumperMusicVol,
              bumperVideoHasAudio: bumperHasAudio,
              bumperMainAudioGainPercent: bumperMainGain,
              outputWidth: first.stream_output_width,
              outputHeight: first.stream_output_height,
              outputFps: first.stream_video_fps
            })
          })()
        : buildFfmpegBumperOverlayOnlyArgs({
            overlayPath: bumperOverlayFs!,
            outputRtmpUrl,
            videoBitrateKbps: first.video_bitrate_kbps,
            videoBitrateMode: first.video_bitrate_mode,
            extraArgs: first.ffmpeg_extra_args,
            targetSec: plan.targetSec,
            bumperMusicConcatListPath: bumperMusicListPath,
            bumperMusicVolumePercent: bumperMusicVol,
            outputWidth: first.stream_output_width,
            outputHeight: first.stream_output_height,
            outputFps: first.stream_video_fps
          })
      updateStreamerProcessState(streamerId, 'live', null)
      let code: number | null = 0
      let stderr = ''
      try {
        const out = await runFfmpegWithCapturedStderr(bumperArgs, session, 'bumper')
        code = out.code
        stderr = out.stderr
      } finally {
        await unlinkQuiet(bumperMusicListPath ?? '')
      }
      if (session.stopRequested) return
      if (code !== 0) {
        updateStreamerProcessState(streamerId, 'error', `ffmpeg bumper: ${stderr || `код выхода ${code ?? '—'}`}`)
        return
      }
    } catch (e) {
      updateStreamerProcessState(streamerId, 'error', e instanceof Error ? e.message : 'Ошибка запуска заглушки')
      return
    }
  }

  while (!session.stopRequested) {
    const row = getStreamerById(streamerId)
    if (!row) break
    const mc = isMinecraftPrewarmOn(row)
    const streamMode = getStreamMode(row)
    const dir = mc ? row.minecraft_prewarm_chunks_folder?.trim() : row.segments_folder_path?.trim()
    if (!mc && streamMode === 'single') {
      const one = row.single_segment_path?.trim()
      if (!one) {
        const msg =
          row.stream_type === 'white_prewarm'
            ? 'Для типа «Прогрев белым» выберите mp4 файл'
            : 'Для режима «Один кусок» выберите mp4 файл'
        updateStreamerProcessState(streamerId, 'error', msg)
        return
      }
    } else if (!dir) {
      updateStreamerProcessState(
        streamerId,
        'error',
        mc ? 'Не указана папка с кусками (Майнкрафт прогрев)' : 'Не указана папка с кусками'
      )
      return
    }
    const segs =
      !mc && streamMode === 'single'
        ? [row.single_segment_path!.trim()]
        : await collectSegmentVideos(dir!)
    if (segs.length === 0) {
      updateStreamerProcessState(streamerId, 'error', 'В папке кусков нет поддерживаемых видео (.mp4, .mov, …)')
      return
    }
    let listPath: string | null = null
    let sfxListPath: string | null = null
    let musicListPath: string | null = null
    let streamBgMusicListPath: string | null = null
    try {
      if (streamMode === 'ordered') {
        listPath = await writeConcatListFileMultiOrderedPasses({ segmentPaths: segs })
      } else if (streamMode === 'single') {
        listPath = await writeSingleSegmentConcatListMultiPasses({ segmentPath: segs[0]! })
      } else {
        listPath = await writeConcatListFileMultiShuffledPasses({ segmentPaths: segs })
      }
    } catch (e) {
      updateStreamerProcessState(
        streamerId,
        'error',
        e instanceof Error ? e.message : 'Ошибка списка concat'
      )
      return
    }

    let args: string[]
    let layoutTempFiles: string[] = []
    if (mc) {
      const audioDir = row.minecraft_prewarm_audio_folder?.trim()
      const musicFs = row.minecraft_prewarm_music_path?.trim()
      if (!audioDir || !musicFs) {
        await unlinkQuiet(listPath!)
        updateStreamerProcessState(streamerId, 'error', 'Майнкрафт прогрев: укажите папку SFX и музыку .mp3')
        return
      }
      let sfxFiles: string[] = []
      try {
        sfxFiles = await collectMinecraftPrewarmAudioMp3(audioDir)
      } catch (e) {
        await unlinkQuiet(listPath!)
        updateStreamerProcessState(
          streamerId,
          'error',
          e instanceof Error ? e.message : 'Папка SFX недоступна'
        )
        return
      }
      if (sfxFiles.length === 0) {
        await unlinkQuiet(listPath!)
        updateStreamerProcessState(streamerId, 'error', 'В папке SFX нет .mp3')
        return
      }
      try {
        sfxListPath = await writeMinecraftSfxConcatListMultiPasses({ audioPaths: sfxFiles })
        const passes = streamerMultiPassCount(segs.length)
        const estVideoSec = Math.max(7200, Math.min(7 * 86400, segs.length * passes * 8))
        musicListPath = await writeMusicRepeatConcatList({
          musicPath: musicFs,
          targetMinDurationSec: estVideoSec
        })
      } catch (e) {
        await unlinkQuiet(listPath!)
        await unlinkQuiet(sfxListPath ?? '')
        await unlinkQuiet(musicListPath ?? '')
        updateStreamerProcessState(
          streamerId,
          'error',
          e instanceof Error ? e.message : 'Ошибка списков SFX/музыки'
        )
        return
      }
      args = buildFfmpegStreamArgsMinecraftPrewarm({
        concatListPath: listPath!,
        sfxConcatListPath: sfxListPath!,
        musicConcatListPath: musicListPath!,
        outputRtmpUrl,
        videoBitrateKbps: row.video_bitrate_kbps,
        videoBitrateMode: row.video_bitrate_mode,
        extraArgs: row.ffmpeg_extra_args,
        outputWidth: row.stream_output_width,
        outputHeight: row.stream_output_height,
        outputFps: row.stream_video_fps
      })
    } else {
      const chLayout = getChannelById(row.channel_id)
      const layoutRaw =
        row.stream_type === 'white_prewarm'
          ? (chLayout?.stream_preview_layout_white_json ?? '')
          : (chLayout?.stream_preview_layout_json ?? '')
      const hydratedLayout = await materializeLayoutDataUrlSourcesForLive(layoutRaw)
      layoutTempFiles = hydratedLayout.tempFiles
      const streamMusicVolFromPreview = parsePreviewMusicVolumeFromLayoutJson(hydratedLayout.layoutJson || '')
      try {
        const sm = row.stream_music_folder_path?.trim()
        if (sm) {
          const tracks = await collectBackgroundMusicFiles(sm)
          if (tracks.length > 0) {
            streamBgMusicListPath = await writeBackgroundMusicShuffledConcatList({
              audioPaths: tracks,
              repeatBlocks: 120
            })
          }
        }
      } catch {
        streamBgMusicListPath = null
      }
      const firstSegPath =
        streamMode === 'single' && row.single_segment_path?.trim()
          ? resolve(row.single_segment_path.trim())
          : segs[0]
            ? resolve(segs[0]!)
            : null
      let concatHasAudio = false
      if (firstSegPath) {
        try {
          concatHasAudio = await ffprobeHasAudioStream(firstSegPath)
        } catch {
          concatHasAudio = false
        }
      }
      const canPrebakeSingleMain =
        streamMode === 'single' &&
        row.stream_type !== 'white_prewarm' &&
        Boolean(row.single_segment_path?.trim()) &&
        Boolean(row.overlay_path?.trim())
      if (canPrebakeSingleMain && firstSegPath) {
        const mainGain = parseMainAudioGainPercentFromPreviewLayoutJson(hydratedLayout.layoutJson || '')
        let prebaked: { prebakedPath: string; hasAudio: boolean } | null = null
        if (prewarmedSingleMainPath && existsSync(prewarmedSingleMainPath)) {
          prebaked = {
            prebakedPath: prewarmedSingleMainPath,
            hasAudio: Boolean(prewarmedSingleMainHasAudio)
          }
        } else {
          appendStreamConsoleLine('[PREBAKE] no prewarmed file, fallback to live graph for this run')
        }
        if (!prebaked) {
          args = buildFfmpegStreamArgs({
            concatListPath: listPath!,
            outputRtmpUrl: outputRtmpUrl,
            overlayPath: row.stream_type === 'white_prewarm' ? null : row.overlay_path,
            videoBitrateKbps: row.video_bitrate_kbps,
            videoBitrateMode: row.video_bitrate_mode,
            extraArgs: row.ffmpeg_extra_args,
            streamPreviewLayoutJson: hydratedLayout.layoutJson || null,
            streamMusicConcatListPath: streamBgMusicListPath,
            streamMusicVolumePercent:
              streamMusicVolFromPreview !== null ? streamMusicVolFromPreview : Number(row.stream_music_volume ?? 100),
            concatVideoHasAudio: concatHasAudio,
            outputWidth: row.stream_output_width,
            outputHeight: row.stream_output_height,
            outputFps: row.stream_video_fps
          })
        } else {
          await unlinkQuiet(listPath!)
          listPath = await writeSingleSegmentConcatListMultiPasses({ segmentPath: prebaked.prebakedPath })
          args = buildFfmpegStreamArgsPrebakedMain({
            concatListPath: listPath!,
            outputRtmpUrl: outputRtmpUrl,
            videoBitrateKbps: row.video_bitrate_kbps,
            videoBitrateMode: row.video_bitrate_mode,
            extraArgs: row.ffmpeg_extra_args,
            streamMusicConcatListPath: streamBgMusicListPath,
            streamMusicVolumePercent:
              streamMusicVolFromPreview !== null ? streamMusicVolFromPreview : Number(row.stream_music_volume ?? 100),
            mainAudioGainPercent: mainGain,
            prebakedVideoHasAudio: prebaked.hasAudio,
            outputFps: row.stream_video_fps
          })
        }
      } else {
        args = buildFfmpegStreamArgs({
          concatListPath: listPath!,
          outputRtmpUrl: outputRtmpUrl,
          overlayPath: row.stream_type === 'white_prewarm' ? null : row.overlay_path,
          videoBitrateKbps: row.video_bitrate_kbps,
          videoBitrateMode: row.video_bitrate_mode,
          extraArgs: row.ffmpeg_extra_args,
          streamPreviewLayoutJson: hydratedLayout.layoutJson || null,
          streamMusicConcatListPath: streamBgMusicListPath,
          streamMusicVolumePercent:
            streamMusicVolFromPreview !== null ? streamMusicVolFromPreview : Number(row.stream_music_volume ?? 100),
          concatVideoHasAudio: concatHasAudio,
          outputWidth: row.stream_output_width,
          outputHeight: row.stream_output_height,
          outputFps: row.stream_video_fps
        })
      }
    }

    updateStreamerProcessState(streamerId, 'live', null)
    let code: number | null = null
    let stderr = ''
    try {
      const out = await runFfmpegWithCapturedStderr(args, session, 'main')
      code = out.code
      stderr = out.stderr
    } finally {
      await unlinkQuiet(listPath!)
      await unlinkQuiet(sfxListPath ?? '')
      await unlinkQuiet(musicListPath ?? '')
      await unlinkQuiet(streamBgMusicListPath ?? '')
      for (const p of layoutTempFiles) {
        await unlinkQuiet(p)
      }
    }

    if (session.stopRequested) break

    if (code !== 0) {
      const hint = stderr.slice(-3500) || `код выхода ${code ?? '—'}`
      updateStreamerProcessState(streamerId, 'error', `ffmpeg: ${hint}`)
      return
    }

    await syncYoutubeBroadcastId(streamerId, session)
    await new Promise<void>((r) => setTimeout(r, 800))
  }

  if (!session.stopRequested) {
    updateStreamerProcessState(streamerId, 'stopped', null)
  }
}

export function isStreamerSessionActive(streamerId: number): boolean {
  return sessions.has(streamerId)
}

export function getStreamerRuntimeVideoBitrateKbps(streamerId: number): number | null {
  return sessions.get(streamerId)?.videoBitrateKbps ?? null
}

export function getStreamerRuntimeUsedProxy(streamerId: number): boolean {
  return sessions.get(streamerId)?.usedProxy ?? false
}

export function getStreamerMainPrebakeStatus(streamerId: number): PrebakeStatus {
  const mem = prebakeStatusByStreamer.get(streamerId)
  if (mem && mem.phase === 'running') return mem
  const row = getStreamerById(streamerId)
  if (
    row &&
    row.stream_type !== 'white_prewarm' &&
    getStreamMode(row) === 'single' &&
    row.single_segment_path?.trim() &&
    row.overlay_path?.trim()
  ) {
    try {
      const sourceVideoPath = resolve(row.single_segment_path.trim())
      const overlayPath = resolve(row.overlay_path.trim())
      const chLayout = getChannelById(row.channel_id)
      const layoutRaw = chLayout?.stream_preview_layout_json ?? ''
      const prebakePath = getMainPrebakeOutputPath({
        videoPath: sourceVideoPath,
        overlayPath,
        layoutJson: layoutRaw,
        outputWidth: row.stream_output_width,
        outputHeight: row.stream_output_height,
        outputFps: row.stream_video_fps,
        bitrateKbps: row.video_bitrate_kbps
      })
      if (existsSync(prebakePath)) {
        return {
          phase: 'done',
          percent: 100,
          message: 'Готово (кэш найден)',
          outputPath: prebakePath,
          cacheHit: true,
          updatedAt: Date.now()
        }
      }
    } catch {
      // ignore probe errors and fallback to in-memory/default status
    }
  }
  return (
    mem ?? {
      phase: 'idle',
      percent: 0,
      message: '',
      outputPath: null,
      cacheHit: false,
      updatedAt: Date.now()
    }
  )
}

export async function startStreamerMainPrebake(
  streamerId: number,
  opts?: { forceRebuild?: boolean }
): Promise<CreateResult<{ started: true }>> {
  if (prebakeTaskByStreamer.has(streamerId)) {
    return { ok: false, error: 'Pre-bake уже выполняется' }
  }
  const row = getStreamerById(streamerId)
  if (!row) return { ok: false, error: 'Стример не найден' }
  const mode = getStreamMode(row)
  if (row.stream_type === 'white_prewarm') {
    return { ok: false, error: 'Pre-bake main доступен только для типа «Казино»' }
  }
  if (mode !== 'single') {
    return { ok: false, error: 'Pre-bake доступен только в режиме «Один кусок»' }
  }
  const videoRaw = row.single_segment_path?.trim()
  const overlayRaw = row.overlay_path?.trim()
  if (!videoRaw) return { ok: false, error: 'Выберите файл куска (.mp4)' }
  if (!overlayRaw) return { ok: false, error: 'Выберите оверлей для стрима' }
  const sourceVideoPath = resolve(videoRaw)
  const overlayPath = resolve(overlayRaw)
  if (!existsSync(sourceVideoPath)) return { ok: false, error: 'Файл куска не найден' }
  if (!existsSync(overlayPath)) return { ok: false, error: 'Файл оверлея не найден' }

  setPrebakeStatus(streamerId, {
    phase: 'running',
    percent: 0,
    message: 'Подготовка pre-bake...',
    outputPath: null,
    cacheHit: false
  })

  const task = (async () => {
    try {
      const chLayout = getChannelById(row.channel_id)
      const layoutRaw = chLayout?.stream_preview_layout_json ?? ''
      const hydrated = await materializeLayoutDataUrlSourcesForLive(layoutRaw)
      try {
        let hasMainAudio = false
        try {
          hasMainAudio = await ffprobeHasAudioStream(sourceVideoPath)
        } catch {
          hasMainAudio = false
        }
        const pre = await ensureSingleMainPrebake({
          streamerId,
          sourceVideoPath,
          overlayPath,
          layoutJson: hydrated.layoutJson || '',
          outputWidth: row.stream_output_width,
          outputHeight: row.stream_output_height,
          outputFps: row.stream_video_fps,
          videoBitrateKbps: row.video_bitrate_kbps,
          videoBitrateMode: row.video_bitrate_mode,
          extraArgs: row.ffmpeg_extra_args,
          concatVideoHasAudio: hasMainAudio,
          forceRebuild: opts?.forceRebuild === true,
          touchStreamerState: false,
          onProgress: (p) => {
            setPrebakeStatus(streamerId, { phase: 'running', percent: p.percent, message: p.message })
          }
        })
        setPrebakeStatus(streamerId, {
          phase: 'done',
          percent: 100,
          message: pre.cacheHit ? 'Готово (взято из кэша)' : 'Готово (pre-bake завершён)',
          outputPath: pre.prebakedPath,
          cacheHit: pre.cacheHit
        })
      } finally {
        for (const p of hydrated.tempFiles) {
          await unlinkQuiet(p)
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('__PREBAKE_CANCELLED__')) {
        setPrebakeStatus(streamerId, {
          phase: 'idle',
          percent: 0,
          message: 'Pre-bake отменён пользователем'
        })
        return
      }
      setPrebakeStatus(streamerId, {
        phase: 'error',
        message: msg
      })
    } finally {
      prebakeCancelRequested.delete(streamerId)
      prebakeProcByStreamer.delete(streamerId)
      prebakeTaskByStreamer.delete(streamerId)
    }
  })()
  prebakeTaskByStreamer.set(streamerId, task)
  return { ok: true, data: { started: true } }
}

export async function cancelStreamerMainPrebake(streamerId: number): Promise<CreateResult<{ cancelled: true }>> {
  if (!prebakeTaskByStreamer.has(streamerId)) {
    return { ok: false, error: 'Pre-bake сейчас не выполняется' }
  }
  prebakeCancelRequested.add(streamerId)
  const proc = prebakeProcByStreamer.get(streamerId)
  if (proc?.pid) {
    await killProcessTree(proc.pid)
  }
  const outPath = prebakeOutPathByStreamer.get(streamerId)
  if (outPath) {
    await unlinkQuiet(outPath)
  }
  setPrebakeStatus(streamerId, {
    phase: 'idle',
    percent: 0,
    message: 'Pre-bake отменён пользователем'
  })
  appendStreamConsoleLine('[PREBAKE] cancelled by user')
  return { ok: true, data: { cancelled: true } }
}

export async function startStreamer(streamerId: number): Promise<CreateResult> {
  if (sessions.has(streamerId)) {
    return { ok: false, error: 'Стример уже запущен' }
  }
  const row = getStreamerById(streamerId)
  if (!row) return { ok: false, error: 'Стример не найден' }
  const ch = getChannelById(row.channel_id)
  if (!ch?.oauth_refresh_token) {
    return { ok: false, error: 'У канала нет OAuth refresh token — подключите YouTube в разделе «Каналы»' }
  }
  const mc = isMinecraftPrewarmOn(row)
  const streamMode = getStreamMode(row)
  const dir = mc ? row.minecraft_prewarm_chunks_folder?.trim() : row.segments_folder_path?.trim()
  if (!mc && streamMode === 'single') {
    const one = row.single_segment_path?.trim()
    if (!one) {
      return {
        ok: false,
        error:
          row.stream_type === 'white_prewarm'
            ? 'Для типа «Прогрев белым» выберите mp4 файл'
            : 'Для режима «Один кусок» выберите mp4 файл'
      }
    }
    try {
      await fsp.access(one)
    } catch {
      return { ok: false, error: 'Файл для режима «Один кусок» не найден' }
    }
  } else if (!dir) {
    return {
      ok: false,
      error: mc ? 'Укажите папку с кусками для «Майнкрафт прогрев»' : 'Укажите папку с видео-кусками'
    }
  }
  if (!mc && streamMode !== 'single') {
    const segs = await collectSegmentVideos(dir!)
    if (segs.length === 0) return { ok: false, error: 'В папке кусков нет видеофайлов' }
  }
  if (mc) {
    const ad = row.minecraft_prewarm_audio_folder?.trim()
    const mus = row.minecraft_prewarm_music_path?.trim()
    if (!ad) return { ok: false, error: 'Майнкрафт прогрев: укажите папку с аудио (.mp3)' }
    if (!mus) return { ok: false, error: 'Майнкрафт прогрев: укажите файл музыки (.mp3)' }
    if (!mus.toLowerCase().endsWith('.mp3')) {
      return { ok: false, error: 'Музыка на стриме должна быть в формате .mp3' }
    }
    const sfx = await collectMinecraftPrewarmAudioMp3(ad)
    if (sfx.length === 0) return { ok: false, error: 'В папке SFX нет .mp3 файлов' }
  }
  if (!hasSocksProxyConfigured(row)) {
    return {
      ok: false,
      error:
        'Нужен SOCKS5-прокси: у стримера или у канала должен быть выбран прокси. Без него RTMP к YouTube отключён — иначе виден ваш IP.'
    }
  }

  updateStreamerProcessState(streamerId, 'starting', null)

  const session: Session = {
    stopRequested: false,
    closeRelay: null,
    ffmpeg: null,
    viewerTimer: null,
    videoBitrateKbps: null,
    usedProxy: false
  }
  sessions.set(streamerId, session)

  await syncYoutubeBroadcastId(streamerId, session)

  void (async () => {
    try {
      await runStreamerLoop(streamerId, session)
    } finally {
      if (session.viewerTimer) clearInterval(session.viewerTimer)
      if (session.closeRelay) await session.closeRelay().catch(() => {})
      sessions.delete(streamerId)
      if (!session.stopRequested) {
        const latest = getStreamerById(streamerId)
        if (latest?.process_status === 'live') {
          updateStreamerProcessState(streamerId, 'stopped', null)
        }
      }
    }
  })()

  return { ok: true }
}

export async function stopStreamer(streamerId: number): Promise<void> {
  const session = sessions.get(streamerId)
  if (!session) {
    updateStreamerProcessState(streamerId, 'stopped', null)
    return
  }
  session.stopRequested = true
  if (session.viewerTimer) {
    clearInterval(session.viewerTimer)
    session.viewerTimer = null
  }
  if (session.ffmpeg?.pid) {
    await killProcessTree(session.ffmpeg.pid)
  }
  session.ffmpeg = null
  if (session.closeRelay) {
    await session.closeRelay().catch(() => {})
    session.closeRelay = null
  }
  updateStreamerProcessState(streamerId, 'stopped', null)
}
