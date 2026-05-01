import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getChannelById, getProxyById } from '@services/db/queries'
import {
  getStreamerById,
  updateStreamerProcessState,
  updateStreamerViewers
} from '@services/db/streamersQueries'
import { getOAuthClientCredentialsForChannel } from '@services/google/oauthForChannel'
import { startSocksTcpRelay } from '@services/stream/tcpRelaySocks'
import {
  collectSegmentVideos,
  unlinkQuiet,
  writeConcatListFileMultiShuffledPasses
} from '@services/stream/streamerConcat'
import { getMediaDurationSeconds } from '@services/stream/ffprobe'
import {
  buildFfmpegBumperDirectArgs,
  buildFfmpegStreamArgs,
  combineRtmpUrl,
  parseRtmpDestination,
  rewriteRtmpUrlForLocalTunnel,
  spawnFfmpeg
} from '@services/stream/streamerFfmpeg'
import { fetchLiveBroadcastConcurrentViewers } from '@services/youtube/liveBroadcast'
import type { ProxyRow, StreamerRow } from '@services/db/types'

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

const sessions = new Map<number, Session>()

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

function appendStderrAndParseBitrate(chunk: string, session: Session, lastStderrRef: { s: string }): void {
  lastStderrRef.s = (lastStderrRef.s + chunk).slice(-7000)
  const kbps = lastBitrateKbpsFromFfmpegStderr(lastStderrRef.s)
  if (kbps != null) session.videoBitrateKbps = kbps
}

async function runFfmpegWithCapturedStderr(args: string[], session: Session): Promise<{ code: number | null; stderr: string }> {
  const progressPath = join(tmpdir(), `ffp-${randomBytes(8).toString('hex')}.txt`)
  const argsWithProgress = withFfmpegProgressFile(args, progressPath)
  let proc: ChildProcess
  try {
    proc = spawnFfmpeg(argsWithProgress)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Не удалось запустить ffmpeg')
  }

  session.ffmpeg = proc
  session.videoBitrateKbps = null
  const lastStderrRef = { s: '' }
  proc.stderr?.on('data', (chunk: Buffer) => {
    appendStderrAndParseBitrate(chunk.toString('utf8'), session, lastStderrRef)
  })

  const tickProgress = (): void => {
    try {
      const txt = readFileSync(progressPath, 'utf8')
      const kbps = lastBitrateKbpsFromProgressFileText(txt)
      if (kbps != null) session.videoBitrateKbps = kbps
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

  if (first.bumper_video_path?.trim()) {
    try {
      const bumperFs = resolve(first.bumper_video_path.trim())
      const durSec = await getMediaDurationSeconds(bumperFs)
      const padShort = durSec != null && durSec > 0 && durSec < 180 ? 180 : undefined
      const bumperArgs = buildFfmpegBumperDirectArgs({
        inputFile: bumperFs,
        outputRtmpUrl,
        extraArgs: first.ffmpeg_extra_args,
        padDurationSecIfShorter: padShort
      })
      updateStreamerProcessState(streamerId, 'live', null)
      const { code, stderr } = await runFfmpegWithCapturedStderr(bumperArgs, session)
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
    const dir = row.segments_folder_path?.trim()
    if (!dir) {
      updateStreamerProcessState(streamerId, 'error', 'Не указана папка с кусками')
      return
    }
    const segs = await collectSegmentVideos(dir)
    if (segs.length === 0) {
      updateStreamerProcessState(streamerId, 'error', 'В папке кусков нет поддерживаемых видео (.mp4, .mov, …)')
      return
    }
    let listPath: string | null = null
    try {
      listPath = await writeConcatListFileMultiShuffledPasses({
        segmentPaths: segs
      })
    } catch (e) {
      updateStreamerProcessState(
        streamerId,
        'error',
        e instanceof Error ? e.message : 'Ошибка списка concat'
      )
      return
    }

    const args = buildFfmpegStreamArgs({
      concatListPath: listPath!,
      outputRtmpUrl: outputRtmpUrl,
      overlayPath: row.overlay_path,
      extraArgs: row.ffmpeg_extra_args
    })

    updateStreamerProcessState(streamerId, 'live', null)
    const { code, stderr } = await runFfmpegWithCapturedStderr(args, session)
    await unlinkQuiet(listPath!)

    if (session.stopRequested) break

    if (code !== 0) {
      const hint = stderr.slice(-3500) || `код выхода ${code ?? '—'}`
      updateStreamerProcessState(streamerId, 'error', `ffmpeg: ${hint}`)
      return
    }

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
  const dir = row.segments_folder_path?.trim()
  if (!dir) return { ok: false, error: 'Укажите папку с видео-кусками' }
  const segs = await collectSegmentVideos(dir)
  if (segs.length === 0) return { ok: false, error: 'В папке кусков нет видеофайлов' }
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

  const bid = row.youtube_broadcast_id?.trim()
  if (bid) {
    session.viewerTimer = startViewerPolling(streamerId, bid, row.channel_id)
  }

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
