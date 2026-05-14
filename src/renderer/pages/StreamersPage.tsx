import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  CheckCircle2,
  Clapperboard,
  ExternalLink,
  Activity,
  FileVideo,
  Film,
  FolderOpen,
  Image as ImageIcon,
  KeyRound,
  Layers,
  Link2,
  ListVideo,
  Loader2,
  MonitorPlay,
  Network,
  RadioTower,
  Play,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Timer,
  Trash2,
  Type,
  UserCircle,
  Volume2,
  VolumeX,
  Video
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  isKnownYoutubeVideoCategoryId,
  YOUTUBE_VIDEO_CATEGORY_OPTIONS
} from '../constants/youtubeVideoCategories'
import { OVERLAY_IMAGE_EXTENSIONS, OVERLAY_VIDEO_EXTENSIONS } from '../constants/overlayAssets'
import adsLogo from '../../../ads_logo.jpg'

type StreamerRow = StreamerListItem
type ChannelRow = Awaited<ReturnType<typeof window.electronAPI.db.listChannels>>[number]
type ProxyRow = Awaited<ReturnType<typeof window.electronAPI.db.listProxies>>[number]
type PrebakeUiStatus = {
  phase: 'idle' | 'running' | 'done' | 'error'
  percent: number
  message: string
  outputPath: string | null
  cacheHit: boolean
  updatedAt: number
}

function bumperPadTargetSecFromForm(props: {
  bumperPadMode: 'legacy' | 'once' | 'custom'
  bumperPadAmount: number
}): number | null {
  if (props.bumperPadMode === 'legacy') return null
  if (props.bumperPadMode === 'once') return 0
  const n = Math.max(1, Math.floor(Number(props.bumperPadAmount) || 1))
  const sec = n * 60
  if (!Number.isFinite(sec) || sec < 1) return null
  return Math.min(sec, 24 * 3600)
}

const BUMPER_AMOUNT_OPTIONS_MIN = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60]

const STREAM_VIDEO_FPS_OPTIONS_UI = [24, 30, 50, 60] as const
type StreamOutputPreset = '720x1280' | '900x1600' | '1080x1920'

function dimensionsFromStreamOutputPreset(preset: StreamOutputPreset): { width: number; height: number } {
  switch (preset) {
    case '720x1280':
      return { width: 720, height: 1280 }
    case '900x1600':
      return { width: 900, height: 1600 }
    case '1080x1920':
      return { width: 1080, height: 1920 }
    default:
      return { width: 1080, height: 1920 }
  }
}

function streamOutputPresetFromDb(w: number, h: number): StreamOutputPreset {
  if (w === 720 && h === 1280) return '720x1280'
  if (w === 900 && h === 1600) return '900x1600'
  return '1080x1920'
}

function ContentSubdivider(props: { icon: LucideIcon; label: string }): JSX.Element {
  const I = props.icon
  return (
    <div className="md:col-span-2 flex items-center gap-3 py-2.5" role="separator" aria-label={props.label}>
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-industrial-border/55 to-industrial-border/30" />
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-industrial-muted">
        <I className="h-3.5 w-3.5 text-industrial-dim" strokeWidth={1.5} aria-hidden />
        {props.label}
      </span>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent via-industrial-border/55 to-industrial-border/30" />
    </div>
  )
}

function FieldLabel(props: { icon: LucideIcon; children: React.ReactNode }): JSX.Element {
  const I = props.icon
  return (
    <span className="inline-flex items-start gap-1.5 text-industrial-muted">
      <I className="mt-0.5 h-3.5 w-3.5 shrink-0 text-industrial-dim" strokeWidth={1.5} aria-hidden />
      <span className="min-w-0 flex-1 leading-snug">{props.children}</span>
    </span>
  )
}

function SectionTitle(props: { icon: LucideIcon; children: React.ReactNode }): JSX.Element {
  const I = props.icon
  return (
    <h3 className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-industrial-muted">
      <I className="h-4 w-4 text-industrial-dim" strokeWidth={1.5} aria-hidden />
      {props.children}
    </h3>
  )
}

function statusLabel(s: string): string {
  switch (s) {
    case 'stopped':
      return 'Остановлен'
    case 'starting':
      return 'Запускается'
    case 'live':
      return 'В эфире'
    case 'error':
      return 'Ошибка'
    default:
      return s
  }
}

export function StreamersPage(): JSX.Element {
  const [rows, setRows] = useState<StreamerRow[]>([])
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [proxies, setProxies] = useState<ProxyRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | 'save' | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)

  const [name, setName] = useState('')
  const [channelId, setChannelId] = useState<number | ''>('')
  const [proxyId, setProxyId] = useState<number | '' | 'inherit'>('inherit')
  const [ingest, setIngest] = useState('rtmp://a.rtmp.youtube.com/live2')
  const [streamKey, setStreamKey] = useState('')
  const [streamType, setStreamType] = useState<'casino' | 'white_prewarm'>('casino')
  const [streamMode, setStreamMode] = useState<'random' | 'ordered' | 'single'>('random')
  const [segmentsDir, setSegmentsDir] = useState('')
  const [singleSegmentPath, setSingleSegmentPath] = useState('')
  const [bumperPath, setBumperPath] = useState('')
  const [bumperOverlayPath, setBumperOverlayPath] = useState('')
  const [overlayPath, setOverlayPath] = useState('')
  const [videoBitrateKbps, setVideoBitrateKbps] = useState(6000)
  const [videoBitrateMode, setVideoBitrateMode] = useState<'cbr' | 'vbr'>('cbr')
  const [streamOutputPreset, setStreamOutputPreset] = useState<StreamOutputPreset>('1080x1920')
  const [streamVideoFps, setStreamVideoFps] = useState(30)
  const [ffmpegExtra, setFfmpegExtra] = useState('')
  const [broadcastId, setBroadcastId] = useState('')
  const [bTitle, setBTitle] = useState('')
  const [bDesc, setBDesc] = useState('')
  const [bTags, setBTags] = useState('')
  const [bPrivacy, setBPrivacy] = useState<'private' | 'public' | 'unlisted'>('private')
  const [bCategory, setBCategory] = useState('22')
  const [bThumbPath, setBThumbPath] = useState('')
  /** legacy | once | custom (для custom считаем минуты -> секунды) */
  const [bumperPadMode, setBumperPadMode] = useState<'legacy' | 'once' | 'custom'>('legacy')
  const [bumperPadAmount, setBumperPadAmount] = useState(3)
  const [bumperMuteAudio, setBumperMuteAudio] = useState(false)
  const [streamMusicFolder, setStreamMusicFolder] = useState('')
  const [streamMusicVol, setStreamMusicVol] = useState(100)
  const [bumperMusicFolder, setBumperMusicFolder] = useState('')
  const [bumperMusicVol, setBumperMusicVol] = useState(100)
  const [prebakeStatus, setPrebakeStatus] = useState<PrebakeUiStatus>({
    phase: 'idle',
    percent: 0,
    message: '',
    outputPath: null,
    cacheHit: false,
    updatedAt: 0
  })

  const reload = useCallback(async () => {
    const [s, ch, pr] = await Promise.all([
      window.electronAPI.db.listStreamers(),
      window.electronAPI.db.listChannels(),
      window.electronAPI.db.listProxies()
    ])
    setRows(s)
    setChannels(ch)
    setProxies(pr)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onDataChanged(() => {
      void (async () => {
        await reload()
        const id = editId
        if (id != null) {
          try {
            const r = await window.electronAPI.db.getStreamer(id)
            if (r) {
              setStreamMusicVol(
                Number.isFinite(Number(r.stream_music_volume))
                  ? Math.max(0, Math.min(200, Number(r.stream_music_volume)))
                  : 100
              )
              setBumperMusicVol(
                Number.isFinite(Number(r.bumper_music_volume))
                  ? Math.max(0, Math.min(200, Number(r.bumper_music_volume)))
                  : 100
              )
              setStreamMusicFolder(r.stream_music_folder_path ?? '')
              setBumperMusicFolder(r.bumper_music_folder_path ?? '')
            }
          } catch {
            // ignore
          }
        }
      })()
    })
    return unsubscribe
  }, [reload, editId])

  useEffect(() => {
    if (!showForm || editId == null || editId < 1) return
    let active = true
    let timer: ReturnType<typeof setInterval> | null = null
    const tick = async (): Promise<void> => {
      try {
        const r = await window.electronAPI.streamers.prebakeMainStatus({ streamerId: editId })
        if (!active || !r.ok) return
        setPrebakeStatus(r.data)
      } catch {
        // ignore polling errors
      }
    }
    void tick()
    timer = setInterval(() => {
      void tick()
    }, 1000)
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [showForm, editId])

  async function openOAuthInAdsForStreamer(streamerId: number, channelId: number): Promise<void> {
    if (busyId !== null) return
    setBusyId(streamerId)
    setError(null)
    try {
      const res = await window.electronAPI.db.oauthBeginManualInAds({ channelId })
      if (!res.ok) {
        const normalized = /fetch failed/i.test(res.error)
          ? 'Ошибка запуска OAuth: не запущен ADS Power'
          : `Ошибка запуска OAuth в ADS: ${res.error}`
        setError(normalized)
        return
      }
      const waitRes = await window.electronAPI.db.oauthWaitManual({
        flowId: res.data.flowId,
        timeoutMs: 240_000
      })
      if (!waitRes.ok) {
        setError(`Автозавершение не сработало: ${waitRes.error}`)
        return
      }
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  async function runOauthFullCheckForStreamer(streamerId: number, channelId: number): Promise<void> {
    if (busyId !== null) return
    setBusyId(streamerId)
    setError(null)
    try {
      const res = await window.electronAPI.db.oauthCheck({ channelId })
      if (!res.ok) setError(res.error)
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  function resetForm(): void {
    setEditId(null)
    setName('')
    setChannelId('')
    setProxyId('inherit')
    setIngest('rtmp://a.rtmp.youtube.com/live2')
    setStreamKey('')
    setStreamType('casino')
    setStreamMode('random')
    setSegmentsDir('')
    setSingleSegmentPath('')
    setBumperPath('')
    setBumperOverlayPath('')
    setOverlayPath('')
    setVideoBitrateKbps(6000)
    setVideoBitrateMode('cbr')
    setStreamOutputPreset('1080x1920')
    setStreamVideoFps(30)
    setFfmpegExtra('')
    setBroadcastId('')
    setBTitle('')
    setBDesc('')
    setBTags('')
    setBPrivacy('private')
    setBCategory('22')
    setBThumbPath('')
    setBumperPadMode('legacy')
    setBumperPadAmount(3)
    setBumperMuteAudio(false)
    setStreamMusicFolder('')
    setStreamMusicVol(100)
    setBumperMusicFolder('')
    setBumperMusicVol(100)
    setPrebakeStatus({
      phase: 'idle',
      percent: 0,
      message: '',
      outputPath: null,
      cacheHit: false,
      updatedAt: 0
    })
  }

  function openCreate(): void {
    resetForm()
    setShowForm(true)
  }

  async function openEdit(id: number): Promise<void> {
    setBusyId(id)
    setError(null)
    try {
      const r = await window.electronAPI.db.getStreamer(id)
      if (!r) {
        setError('Стример не найден')
        return
      }
      setEditId(id)
      setName(r.name)
      setChannelId(r.channel_id)
      setProxyId(r.proxy_id == null ? 'inherit' : r.proxy_id)
      setIngest(r.rtmp_ingest_url)
      setStreamKey(r.rtmp_stream_key)
      setStreamType(r.stream_type === 'white_prewarm' ? 'white_prewarm' : 'casino')
      setStreamMode(r.stream_mode === 'ordered' || r.stream_mode === 'single' ? r.stream_mode : 'random')
      setSegmentsDir(r.segments_folder_path ?? '')
      setSingleSegmentPath(r.single_segment_path ?? '')
      setBumperPath(r.bumper_video_path ?? '')
      setBumperOverlayPath(r.bumper_overlay_path ?? '')
      setBumperMuteAudio(r.bumper_mute_audio === 1)
      setStreamMusicFolder(r.stream_music_folder_path ?? '')
      setStreamMusicVol(
        Number.isFinite(Number(r.stream_music_volume)) ? Math.max(0, Math.min(200, Number(r.stream_music_volume))) : 100
      )
      setBumperMusicFolder(r.bumper_music_folder_path ?? '')
      setBumperMusicVol(
        Number.isFinite(Number(r.bumper_music_volume)) ? Math.max(0, Math.min(200, Number(r.bumper_music_volume))) : 100
      )
      setOverlayPath(r.overlay_path ?? '')
      setVideoBitrateKbps(
        Number.isFinite(Number(r.video_bitrate_kbps)) ? Math.max(200, Number(r.video_bitrate_kbps)) : 6000
      )
      setVideoBitrateMode(r.video_bitrate_mode === 'vbr' ? 'vbr' : 'cbr')
      {
        const w = Math.floor(Number(r.stream_output_width))
        const h = Math.floor(Number(r.stream_output_height))
        setStreamOutputPreset(streamOutputPresetFromDb(w, h))
        const fp = Math.floor(Number(r.stream_video_fps))
        setStreamVideoFps((STREAM_VIDEO_FPS_OPTIONS_UI as readonly number[]).includes(fp) ? fp : 30)
      }
      setFfmpegExtra(r.ffmpeg_extra_args ?? '')
      setBroadcastId(r.youtube_broadcast_id ?? '')
      setBTitle(r.broadcast_title ?? '')
      setBDesc(r.broadcast_description ?? '')
      setBTags(r.broadcast_tags ?? '')
      setBPrivacy(
        r.broadcast_privacy === 'public' || r.broadcast_privacy === 'unlisted' ? r.broadcast_privacy : 'private'
      )
      setBCategory(r.broadcast_category_id || '22')
      setBThumbPath(r.broadcast_thumb_path ?? '')
      {
        const sec = r.bumper_pad_target_sec
        if (sec == null) {
          setBumperPadMode('legacy')
        } else if (sec === 0) {
          setBumperPadMode('once')
        } else {
          setBumperPadMode('custom')
          setBumperPadAmount(Math.max(1, Math.round(sec / 60)))
        }
      }
      setShowForm(true)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-industrial-text">Стримы</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => openCreate()}
            className="border border-industrial-border bg-industrial-raised px-3 py-1.5 text-xs text-industrial-text hover:bg-industrial-panel"
          >
            + Стример
          </button>
        </div>
      </div>

      {error ? (
        <div className="max-h-48 overflow-auto whitespace-pre-wrap break-all border border-red-900/50 bg-red-950/30 px-3 py-2 font-mono text-xs text-red-200">
          {error}
        </div>
      ) : null}

      {showForm ? (
        <StreamerEditorForm
          editId={editId}
          name={name}
          setName={setName}
          channelId={channelId}
          setChannelId={setChannelId}
          proxyId={proxyId}
          setProxyId={setProxyId}
          ingest={ingest}
          setIngest={setIngest}
          streamKey={streamKey}
          setStreamKey={setStreamKey}
          streamType={streamType}
          setStreamType={setStreamType}
          streamMode={streamMode}
          setStreamMode={setStreamMode}
          segmentsDir={segmentsDir}
          setSegmentsDir={setSegmentsDir}
          singleSegmentPath={singleSegmentPath}
          setSingleSegmentPath={setSingleSegmentPath}
          bumperPath={bumperPath}
          setBumperPath={setBumperPath}
          bumperOverlayPath={bumperOverlayPath}
          setBumperOverlayPath={setBumperOverlayPath}
          overlayPath={overlayPath}
          setOverlayPath={setOverlayPath}
          videoBitrateKbps={videoBitrateKbps}
          setVideoBitrateKbps={setVideoBitrateKbps}
          videoBitrateMode={videoBitrateMode}
          setVideoBitrateMode={setVideoBitrateMode}
          streamOutputPreset={streamOutputPreset}
          setStreamOutputPreset={setStreamOutputPreset}
          streamVideoFps={streamVideoFps}
          setStreamVideoFps={setStreamVideoFps}
          ffmpegExtra={ffmpegExtra}
          setFfmpegExtra={setFfmpegExtra}
          broadcastId={broadcastId}
          setBroadcastId={setBroadcastId}
          bTitle={bTitle}
          setBTitle={setBTitle}
          bDesc={bDesc}
          setBDesc={setBDesc}
          bTags={bTags}
          setBTags={setBTags}
          bPrivacy={bPrivacy}
          setBPrivacy={setBPrivacy}
          bCategory={bCategory}
          setBCategory={setBCategory}
          bThumbPath={bThumbPath}
          setBThumbPath={setBThumbPath}
          bumperPadMode={bumperPadMode}
          setBumperPadMode={setBumperPadMode}
          bumperPadAmount={bumperPadAmount}
          setBumperPadAmount={setBumperPadAmount}
          bumperMuteAudio={bumperMuteAudio}
          setBumperMuteAudio={setBumperMuteAudio}
          streamMusicFolder={streamMusicFolder}
          setStreamMusicFolder={setStreamMusicFolder}
          streamMusicVol={streamMusicVol}
          setStreamMusicVol={setStreamMusicVol}
          bumperMusicFolder={bumperMusicFolder}
          setBumperMusicFolder={setBumperMusicFolder}
          bumperMusicVol={bumperMusicVol}
          setBumperMusicVol={setBumperMusicVol}
          prebakeStatus={prebakeStatus}
          onPrebakeStart={async () => {
            if (editId == null || editId < 1) {
              setError('Сначала сохраните стример, потом запускайте pre-bake')
              return
            }
            setError(null)
            const r = await window.electronAPI.streamers.prebakeMainStart({ streamerId: editId, forceRebuild: false })
            if (!r.ok) setError(r.error)
          }}
          onPrebakeRebuild={async () => {
            if (editId == null || editId < 1) {
              setError('Сначала сохраните стример, потом запускайте pre-bake')
              return
            }
            setError(null)
            const r = await window.electronAPI.streamers.prebakeMainStart({ streamerId: editId, forceRebuild: true })
            if (!r.ok) setError(r.error)
          }}
          onPrebakeCancel={async () => {
            if (editId == null || editId < 1) return
            setError(null)
            const r = await window.electronAPI.streamers.prebakeMainCancel({ streamerId: editId })
            if (!r.ok) setError(r.error)
          }}
          channels={channels}
          proxies={proxies}
          busyId={busyId}
          setBusyId={setBusyId}
          setError={setError}
          onClose={() => {
            setShowForm(false)
            resetForm()
          }}
          onMetaApplied={async () => {
            await reload()
          }}
          onSaved={async () => {
            await reload()
            setShowForm(false)
            resetForm()
          }}
        />
      ) : null}

      <div className="overflow-auto border border-industrial-border">
        <table className="w-full min-w-[980px] border-collapse text-left text-xs">
          <thead className="bg-industrial-panel text-industrial-muted">
            <tr>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Название</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Канал</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">OAuth</th>
              <th
                className="border-b border-industrial-border px-2 py-2 font-medium"
                title="Имя SOCKS5-профиля из раздела «Прокси» (у стримера или канала). «—» — не назначен."
              >
                Прокси
              </th>
              <th
                className="border-b border-industrial-border px-2 py-2 font-medium"
                title="При эфире: ffmpeg → локальный туннель → SOCKS5 → YouTube. «—», пока сессия не starting/live."
              >
                RTMP
              </th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Битрейт</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Статус</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Зрители</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Ключ</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="text-industrial-text">
            {rows.map((r) => (
              <tr
                key={r.id}
                className={[
                  'border-b border-industrial-border/80 hover:bg-industrial-panel/40',
                  r.process_status === 'live' || r.process_status === 'starting'
                    ? 'bg-emerald-950/15 ring-1 ring-inset ring-emerald-600/70'
                    : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <td className="px-2 py-2 font-medium">{r.name}</td>
                <td className="px-2 py-2 text-industrial-muted">{r.channel_title ?? `#${r.channel_id}`}</td>
                <td className="px-2 py-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {r.channel_oauth_status === 'ok' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" strokeWidth={1.5} aria-hidden />
                    ) : r.channel_oauth_status === 'invalid' ? (
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" strokeWidth={1.5} aria-hidden />
                    ) : (
                      <Timer className="h-3.5 w-3.5 shrink-0 text-industrial-dim" strokeWidth={1.5} aria-hidden />
                    )}
                    <button
                      type="button"
                      disabled={
                        busyId === r.id ||
                        !(r.channel_ads_profile_id && String(r.channel_ads_profile_id).trim())
                      }
                      onClick={() => void openOAuthInAdsForStreamer(r.id, r.channel_id)}
                      className="inline-flex items-center border border-industrial-border bg-industrial-bg px-1.5 py-0.5 text-[10px] text-emerald-300 hover:border-industrial-muted disabled:opacity-40"
                      title="Открыть привязку OAuth в ADS (новая вкладка в профиле)"
                    >
                      <img src={adsLogo} alt="" className="h-3 w-3 rounded-[2px] object-cover" />
                    </button>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => void runOauthFullCheckForStreamer(r.id, r.channel_id)}
                      className="inline-flex items-center border border-industrial-border bg-industrial-bg px-1.5 py-0.5 text-industrial-text hover:border-industrial-muted disabled:opacity-40"
                      title="Полная проверка OAuth (YouTube API)"
                    >
                      <CheckCircle2 className="h-3 w-3" strokeWidth={1.5} aria-hidden />
                    </button>
                  </div>
                </td>
                <td className="px-2 py-2 text-industrial-muted">{r.proxy_name ?? '—'}</td>
                <td className="px-2 py-2 text-industrial-muted">
                  {r.process_status === 'live' || r.process_status === 'starting'
                    ? r.runtime_rtmp_via_proxy
                      ? 'SOCKS'
                      : 'прямой'
                    : '—'}
                </td>
                <td className="px-2 py-2 font-mono text-[11px] text-industrial-muted">
                  {r.runtime_video_bitrate_kbps != null && Number.isFinite(r.runtime_video_bitrate_kbps)
                    ? `${Math.round(r.runtime_video_bitrate_kbps)} kbps`
                    : '—'}
                </td>
                <td className="px-2 py-2">
                  <span className="text-industrial-muted">{statusLabel(r.process_status)}</span>
                  {r.process_error_message ? (
                    <div className="mt-0.5 max-h-32 max-w-md overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-industrial-dim">
                      {r.process_error_message}
                    </div>
                  ) : null}
                </td>
                <td className="px-2 py-2 text-industrial-muted">
                  {r.last_viewer_count != null ? r.last_viewer_count : '—'}
                </td>
                <td className="px-2 py-2 font-mono text-[10px] text-industrial-dim">{r.rtmp_stream_key_masked}</td>
                <td className="px-2 py-2">
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => void openEdit(r.id)}
                      className="border border-industrial-border px-2 py-1 text-[11px] hover:bg-industrial-raised disabled:opacity-50"
                    >
                      Настройки
                    </button>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => {
                        void (async () => {
                          const res = await window.electronAPI.streamers.openRuntimeConsole()
                          if (!res.ok) setError(res.error)
                        })()
                      }}
                      className="inline-flex items-center gap-1 border border-industrial-border px-2 py-1 text-[11px] hover:bg-industrial-raised"
                      title="Открыть отдельное окно живой консоли ffmpeg"
                    >
                      <Terminal className="h-3 w-3" strokeWidth={1.5} /> Консоль
                    </button>
                    {r.process_status === 'live' || r.process_status === 'starting' ? (
                      <>
                        {r.youtube_broadcast_id?.trim() ? (
                          <button
                            type="button"
                            disabled={busyId === r.id}
                            onClick={() => {
                              void (async () => {
                                const id = r.youtube_broadcast_id!.trim()
                                const url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
                                const res = await window.electronAPI.openExternalUrl(url)
                                if (!res.ok) setError(res.error)
                              })()
                            }}
                            className="inline-flex items-center gap-1 border border-industrial-border px-2 py-1 text-[11px] hover:bg-industrial-raised"
                          >
                            <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                            Перейти на стрим
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={busyId === r.id}
                          onClick={async () => {
                            setBusyId(r.id)
                            try {
                              await window.electronAPI.streamers.stop({ streamerId: r.id })
                              await reload()
                            } finally {
                              setBusyId(null)
                            }
                          }}
                          className="inline-flex items-center gap-1 border border-industrial-border px-2 py-1 text-[11px] hover:bg-industrial-raised"
                        >
                          <Square className="h-3 w-3" strokeWidth={1.5} /> Стоп
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === r.id}
                        onClick={async () => {
                          setBusyId(r.id)
                          setError(null)
                          try {
                            const res = await window.electronAPI.streamers.start({ streamerId: r.id })
                            if (!res.ok) setError(res.error)
                            await reload()
                          } finally {
                            setBusyId(null)
                          }
                        }}
                        className="inline-flex items-center gap-1 border border-industrial-border px-2 py-1 text-[11px] hover:bg-industrial-raised"
                      >
                        <Play className="h-3 w-3" strokeWidth={1.5} /> Старт
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={async () => {
                        if (!confirm(`Удалить стримера «${r.name}»?`)) return
                        setBusyId(r.id)
                        try {
                          const d = await window.electronAPI.db.deleteStreamer(r.id)
                          if (!d.ok) setError(d.error)
                          await reload()
                        } finally {
                          setBusyId(null)
                        }
                      }}
                      className="inline-flex items-center gap-1 border border-red-900/40 px-2 py-1 text-[11px] text-red-200 hover:bg-red-950/30"
                    >
                      <Trash2 className="h-3 w-3" strokeWidth={1.5} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-industrial-muted">
                  Нет стримеров. Нажмите «+ Стример».
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

type PreviewMissingField = 'bumperVideo' | 'bumperOverlay' | 'streamSource' | 'streamOverlay'

function StreamerEditorForm(props: {
  editId: number | null
  name: string
  setName: (v: string) => void
  channelId: number | ''
  setChannelId: (v: number | '') => void
  proxyId: number | '' | 'inherit'
  setProxyId: (v: number | '' | 'inherit') => void
  ingest: string
  setIngest: (v: string) => void
  streamKey: string
  setStreamKey: (v: string) => void
  streamType: 'casino' | 'white_prewarm'
  setStreamType: (v: 'casino' | 'white_prewarm') => void
  streamMode: 'random' | 'ordered' | 'single'
  setStreamMode: (v: 'random' | 'ordered' | 'single') => void
  segmentsDir: string
  setSegmentsDir: (v: string) => void
  singleSegmentPath: string
  setSingleSegmentPath: (v: string) => void
  bumperPath: string
  setBumperPath: (v: string) => void
  bumperOverlayPath: string
  setBumperOverlayPath: (v: string) => void
  overlayPath: string
  setOverlayPath: (v: string) => void
  videoBitrateKbps: number
  setVideoBitrateKbps: (v: number) => void
  videoBitrateMode: 'cbr' | 'vbr'
  setVideoBitrateMode: (v: 'cbr' | 'vbr') => void
  streamOutputPreset: StreamOutputPreset
  setStreamOutputPreset: (v: StreamOutputPreset) => void
  streamVideoFps: number
  setStreamVideoFps: (v: number) => void
  ffmpegExtra: string
  setFfmpegExtra: (v: string) => void
  broadcastId: string
  setBroadcastId: (v: string) => void
  bTitle: string
  setBTitle: (v: string) => void
  bDesc: string
  setBDesc: (v: string) => void
  bTags: string
  setBTags: (v: string) => void
  bPrivacy: 'private' | 'public' | 'unlisted'
  setBPrivacy: (v: 'private' | 'public' | 'unlisted') => void
  bCategory: string
  setBCategory: (v: string) => void
  bThumbPath: string
  setBThumbPath: (v: string) => void
  bumperPadMode: 'legacy' | 'once' | 'custom'
  setBumperPadMode: (v: 'legacy' | 'once' | 'custom') => void
  bumperPadAmount: number
  setBumperPadAmount: (v: number) => void
  bumperMuteAudio: boolean
  setBumperMuteAudio: (v: boolean) => void
  streamMusicFolder: string
  setStreamMusicFolder: (v: string) => void
  streamMusicVol: number
  setStreamMusicVol: (v: number) => void
  bumperMusicFolder: string
  setBumperMusicFolder: (v: string) => void
  bumperMusicVol: number
  setBumperMusicVol: (v: number) => void
  prebakeStatus: PrebakeUiStatus
  onPrebakeStart: () => Promise<void>
  onPrebakeRebuild: () => Promise<void>
  onPrebakeCancel: () => Promise<void>
  channels: ChannelRow[]
  proxies: ProxyRow[]
  busyId: number | 'save' | null
  setBusyId: (v: number | 'save' | null) => void
  setError: (v: string | null) => void
  onClose: () => void
  onMetaApplied: () => Promise<void>
  onSaved: () => Promise<void>
}): JSX.Element {
  const saving = props.busyId === 'save'
  const [applyBusy, setApplyBusy] = useState(false)
  const [suggestBusy, setSuggestBusy] = useState(false)
  /** Временный лог ответа YouTube API после «Применить метаданные» (скопируйте для отладки). */
  const [applyDebugLog, setApplyDebugLog] = useState<string | null>(null)

  const categoryRaw = props.bCategory.trim()
  const categorySelectValue = categoryRaw || '22'
  const categoryShowLegacy = categoryRaw !== '' && !isKnownYoutubeVideoCategoryId(categoryRaw)
  const effectiveStreamMode: 'random' | 'ordered' | 'single' =
    props.streamType === 'white_prewarm' ? 'single' : props.streamMode
  const isCasino = props.streamType === 'casino'

  const cueNameOk = props.name.trim().length > 0
  const cueChannelOk = props.channelId !== '' && props.channelId >= 1
  const cueStreamKeyOk = props.streamKey.trim().length > 0
  const cueBumperVideoOk = props.bumperPath.trim().length > 0
  const cueBumperOverlayOk = props.bumperOverlayPath.trim().length > 0
  const cueBumperSceneOk = cueBumperVideoOk || cueBumperOverlayOk
  const cueStreamSourceOk =
    effectiveStreamMode === 'single' ? props.singleSegmentPath.trim().length > 0 : props.segmentsDir.trim().length > 0
  const cueStreamOverlayOk = props.overlayPath.trim().length > 0
  const canPrebakeMain =
    props.editId != null &&
    props.streamType === 'casino' &&
    effectiveStreamMode === 'single' &&
    props.singleSegmentPath.trim().length > 0 &&
    props.overlayPath.trim().length > 0

  const [previewMissingFields, setPreviewMissingFields] = useState<PreviewMissingField[]>([])

  useEffect(() => {
    setPreviewMissingFields((prev) => {
      if (prev.length === 0) return prev
      const stillMissing = (f: PreviewMissingField): boolean => {
        if (f === 'bumperVideo') return !props.bumperPath.trim()
        if (f === 'bumperOverlay') return !props.bumperOverlayPath.trim()
        if (f === 'streamSource') {
          return effectiveStreamMode === 'single'
            ? !props.singleSegmentPath.trim()
            : !props.segmentsDir.trim()
        }
        if (f === 'streamOverlay') return props.streamType === 'casino' && !props.overlayPath.trim()
        return false
      }
      const next = prev.filter(stillMissing)
      return next.length === prev.length ? prev : next
    })
  }, [
    props.bumperPath,
    props.bumperOverlayPath,
    props.singleSegmentPath,
    props.segmentsDir,
    props.overlayPath,
    props.streamType,
    effectiveStreamMode
  ])

  function previewFieldClass(highlight: boolean): string {
    return highlight
      ? 'min-w-0 flex-1 border border-amber-600/70 bg-industrial-bg px-2 py-1.5 font-mono text-[11px] ring-2 ring-amber-500/35'
      : 'min-w-0 flex-1 border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]'
  }

  /** Едва заметно: лёгкий красный — ещё пусто; зелёный — уже указано. */
  function subtleFieldCue(active: boolean, complete: boolean): string {
    if (!active) return ''
    return complete
      ? 'rounded-md ring-1 ring-inset ring-emerald-500/10 bg-emerald-500/[0.028] px-2 py-1.5 sm:px-2.5'
      : 'rounded-md ring-1 ring-inset ring-red-400/[0.07] bg-red-500/[0.055] px-2 py-1.5 sm:px-2.5'
  }

  async function invokeOpenPreview(focus: 'stream' | 'bumper'): Promise<void> {
    props.setError(null)
    const missing: PreviewMissingField[] = []
    if (focus === 'bumper') {
      if (!props.bumperPath.trim() && !props.bumperOverlayPath.trim()) {
        missing.push('bumperVideo', 'bumperOverlay')
      }
    } else {
      const srcOk =
        effectiveStreamMode === 'single' ? Boolean(props.singleSegmentPath.trim()) : Boolean(props.segmentsDir.trim())
      if (!srcOk) missing.push('streamSource')
      if (props.streamType === 'casino' && !props.overlayPath.trim()) missing.push('streamOverlay')
    }
    if (missing.length > 0) {
      setPreviewMissingFields(missing)
      const parts: string[] = []
      if (missing.includes('bumperVideo') || missing.includes('bumperOverlay')) {
        parts.push('Выберите хотя бы один источник начальной сцены: видео или оверлей (картинка/GIF/видео).')
      }
      if (missing.includes('streamSource')) parts.push('Вы не выбрали видео для стрима (файл или папку с кусками).')
      if (missing.includes('streamOverlay')) parts.push('Вы не выбрали оверлей для стрима.')
      props.setError(parts.join(' '))
      return
    }
    setPreviewMissingFields([])
    const { width: outW, height: outH } = dimensionsFromStreamOutputPreset(props.streamOutputPreset)
    const outFpsRaw = Math.floor(props.streamVideoFps)
    const outFps = (STREAM_VIDEO_FPS_OPTIONS_UI as readonly number[]).includes(outFpsRaw) ? outFpsRaw : 30
    const r = await window.electronAPI.streamers.openPreview({
      preview_focus: focus,
      streamer_id: props.editId ?? undefined,
      channel_id: props.channelId === '' ? undefined : props.channelId,
      stream_type: props.streamType,
      stream_mode: effectiveStreamMode,
      segments_folder_path: effectiveStreamMode === 'single' ? null : props.segmentsDir.trim() || null,
      single_segment_path: props.singleSegmentPath.trim() || null,
      overlay_path: props.streamType === 'white_prewarm' ? null : props.overlayPath.trim() || null,
      bumper_video_path: props.streamType === 'white_prewarm' ? null : props.bumperPath.trim() || null,
      bumper_overlay_path: props.streamType === 'white_prewarm' ? null : props.bumperOverlayPath.trim() || null,
      video_bitrate_kbps: Math.max(200, Math.min(50000, Math.floor(props.videoBitrateKbps || 6000))),
      video_bitrate_mode: props.videoBitrateMode,
      stream_output_width: outW,
      stream_output_height: outH,
      stream_video_fps: outFps,
      ffmpeg_extra_args: props.ffmpegExtra.trim() || null
    })
    if (!r.ok) props.setError(r.error)
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const nm = props.name.trim()
    if (!nm) {
      props.setError('Укажите название')
      return
    }
    if (props.channelId === '' || props.channelId < 1) {
      props.setError('Выберите канал')
      return
    }
    props.setBusyId('save')
    props.setError(null)
    const { width: outW, height: outH } = dimensionsFromStreamOutputPreset(props.streamOutputPreset)
    const outFpsRaw = Math.floor(props.streamVideoFps)
    const outFps = (STREAM_VIDEO_FPS_OPTIONS_UI as readonly number[]).includes(outFpsRaw) ? outFpsRaw : 30
    try {
      const proxy =
        props.proxyId === 'inherit' || props.proxyId === '' ? null : (props.proxyId as number)
      if (props.editId == null) {
        const r = await window.electronAPI.db.createStreamer({
          name: nm,
          channel_id: props.channelId as number,
          proxy_id: proxy
        })
        if (!r.ok) {
          props.setError(r.error)
          return
        }
        const id = r.data.id
        const up = await window.electronAPI.db.updateStreamer({
          id,
          rtmp_ingest_url: props.ingest.trim(),
          rtmp_stream_key: props.streamKey.trim(),
          segments_folder_path: effectiveStreamMode === 'single' ? null : props.segmentsDir.trim() || null,
          stream_type: props.streamType,
          stream_mode: effectiveStreamMode,
          single_segment_path: effectiveStreamMode === 'single' ? props.singleSegmentPath.trim() || null : null,
          bumper_video_path: props.streamType === 'white_prewarm' ? null : props.bumperPath.trim() || null,
          bumper_overlay_path: props.streamType === 'white_prewarm' ? null : props.bumperOverlayPath.trim() || null,
          overlay_path: props.streamType === 'white_prewarm' ? null : props.overlayPath.trim() || null,
          video_bitrate_kbps: Math.max(200, Math.min(50000, Math.floor(props.videoBitrateKbps || 6000))),
          video_bitrate_mode: props.videoBitrateMode,
          stream_output_width: outW,
          stream_output_height: outH,
          stream_video_fps: outFps,
          ffmpeg_extra_args: props.ffmpegExtra.trim() || null,
          youtube_broadcast_id: props.broadcastId.trim() || null,
          broadcast_title: props.bTitle.trim() || null,
          broadcast_description: props.bDesc.trim() || null,
          broadcast_tags: props.bTags.trim() || null,
          broadcast_privacy: props.bPrivacy,
          broadcast_category_id: props.bCategory.trim() || '22',
          broadcast_thumb_path: props.bThumbPath.trim() || null,
          bumper_pad_target_sec: props.streamType === 'white_prewarm' ? null : bumperPadTargetSecFromForm(props),
          bumper_mute_audio: props.streamType === 'white_prewarm' ? 0 : props.bumperMuteAudio ? 1 : 0,
          stream_music_folder_path: props.streamMusicFolder.trim() || null,
          stream_music_volume: Math.max(0, Math.min(200, Math.floor(props.streamMusicVol))),
          bumper_music_folder_path:
            props.streamType === 'white_prewarm' ? null : props.bumperMusicFolder.trim() || null,
          bumper_music_volume:
            props.streamType === 'white_prewarm' ? 100 : Math.max(0, Math.min(200, Math.floor(props.bumperMusicVol))),
          minecraft_prewarm_enabled: 0,
          minecraft_prewarm_chunks_folder: null,
          minecraft_prewarm_audio_folder: null,
          minecraft_prewarm_music_path: null
        })
        if (!up.ok) props.setError(up.error)
        else await props.onSaved()
      } else {
        const up = await window.electronAPI.db.updateStreamer({
          id: props.editId,
          name: nm,
          channel_id: props.channelId as number,
          proxy_id: proxy,
          rtmp_ingest_url: props.ingest.trim(),
          rtmp_stream_key: props.streamKey.trim(),
          segments_folder_path: effectiveStreamMode === 'single' ? null : props.segmentsDir.trim() || null,
          stream_type: props.streamType,
          stream_mode: effectiveStreamMode,
          single_segment_path: effectiveStreamMode === 'single' ? props.singleSegmentPath.trim() || null : null,
          bumper_video_path: props.streamType === 'white_prewarm' ? null : props.bumperPath.trim() || null,
          bumper_overlay_path: props.streamType === 'white_prewarm' ? null : props.bumperOverlayPath.trim() || null,
          overlay_path: props.streamType === 'white_prewarm' ? null : props.overlayPath.trim() || null,
          video_bitrate_kbps: Math.max(200, Math.min(50000, Math.floor(props.videoBitrateKbps || 6000))),
          video_bitrate_mode: props.videoBitrateMode,
          stream_output_width: outW,
          stream_output_height: outH,
          stream_video_fps: outFps,
          ffmpeg_extra_args: props.ffmpegExtra.trim() || null,
          youtube_broadcast_id: props.broadcastId.trim() || null,
          broadcast_title: props.bTitle.trim() || null,
          broadcast_description: props.bDesc.trim() || null,
          broadcast_tags: props.bTags.trim() || null,
          broadcast_privacy: props.bPrivacy,
          broadcast_category_id: props.bCategory.trim() || '22',
          broadcast_thumb_path: props.bThumbPath.trim() || null,
          bumper_pad_target_sec: props.streamType === 'white_prewarm' ? null : bumperPadTargetSecFromForm(props),
          bumper_mute_audio: props.streamType === 'white_prewarm' ? 0 : props.bumperMuteAudio ? 1 : 0,
          stream_music_folder_path: props.streamMusicFolder.trim() || null,
          stream_music_volume: Math.max(0, Math.min(200, Math.floor(props.streamMusicVol))),
          bumper_music_folder_path:
            props.streamType === 'white_prewarm' ? null : props.bumperMusicFolder.trim() || null,
          bumper_music_volume:
            props.streamType === 'white_prewarm' ? 100 : Math.max(0, Math.min(200, Math.floor(props.bumperMusicVol))),
          minecraft_prewarm_enabled: 0,
          minecraft_prewarm_chunks_folder: null,
          minecraft_prewarm_audio_folder: null,
          minecraft_prewarm_music_path: null
        })
        if (!up.ok) props.setError(up.error)
        else await props.onSaved()
      }
    } finally {
      props.setBusyId(null)
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="border border-industrial-border bg-industrial-panel/50 p-4 text-xs text-industrial-text"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="font-medium">{props.editId == null ? 'Новый стример' : `Стример #${props.editId}`}</div>
        <button
          type="button"
          onClick={props.onClose}
          className="text-industrial-muted hover:text-industrial-text"
        >
          Закрыть
        </button>
      </div>

      <div className="flex max-w-3xl flex-col gap-4">
        <section className="rounded-lg border border-industrial-border/60 bg-industrial-panel/30 p-3 md:p-4 shadow-sm shadow-black/20">
          <SectionTitle icon={Link2}>Канал и ключ стрима</SectionTitle>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className={`flex min-w-0 flex-col gap-1 ${subtleFieldCue(true, cueNameOk)}`}>
              <FieldLabel icon={Type}>Название</FieldLabel>
              <input
                value={props.name}
                onChange={(e) => props.setName(e.target.value)}
                className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
              />
            </label>
            <label className={`flex min-w-0 flex-col gap-1 ${subtleFieldCue(true, cueChannelOk)}`}>
              <FieldLabel icon={UserCircle}>Канал (OAuth)</FieldLabel>
              <select
                value={props.channelId === '' ? '' : String(props.channelId)}
                onChange={(e) => props.setChannelId(e.target.value ? Number(e.target.value) : '')}
                className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
              >
                <option value="">—</option>
                {props.channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.channel_title ?? `Канал #${c.id}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 md:col-span-2">
              <FieldLabel icon={Network}>Прокси для RTMP (пусто = как у канала)</FieldLabel>
              <select
                value={props.proxyId === 'inherit' ? '' : String(props.proxyId)}
                onChange={(e) => {
                  const v = e.target.value
                  props.setProxyId(v === '' ? 'inherit' : Number(v))
                }}
                className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
              >
                <option value="">Как у канала</option>
                {props.proxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? `${p.host}:${p.port}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 md:col-span-2">
              <FieldLabel icon={Link2}>RTMP ingest URL</FieldLabel>
              <input
                value={props.ingest}
                onChange={(e) => props.setIngest(e.target.value)}
                className="border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
              />
            </label>
            <label className={`flex min-w-0 flex-col gap-1 md:col-span-2 ${subtleFieldCue(true, cueStreamKeyOk)}`}>
              <FieldLabel icon={KeyRound}>Stream key (из YouTube Studio)</FieldLabel>
              <input
                value={props.streamKey}
                onChange={(e) => props.setStreamKey(e.target.value)}
                className="border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
              />
            </label>
          </div>
        </section>

        <section className="rounded-lg border border-industrial-border/60 bg-industrial-panel/30 p-3 md:p-4 shadow-sm shadow-black/20">
          <SectionTitle icon={ListVideo}>Контент на стриме</SectionTitle>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {props.streamType === 'casino' ? (
              <>
                <ContentSubdivider icon={Clapperboard} label="Начальная сцена" />
                <div className="md:col-span-2 space-y-3 rounded-lg bg-industrial-bg/10 p-3 pl-4">
                  <div>
                    <button
                      type="button"
                      onClick={() => void invokeOpenPreview('bumper')}
                      className="inline-flex items-center gap-2 rounded-md border border-industrial-border/80 bg-industrial-bg px-3 py-1.5 text-xs text-industrial-text hover:border-industrial-muted hover:bg-industrial-raised/30"
                    >
                      <MonitorPlay className="h-3.5 w-3.5 text-industrial-dim" strokeWidth={1.5} aria-hidden />
                      Предпросмотр начальной сцены
                    </button>
                  </div>
                  <label className={`flex min-w-0 flex-col gap-1 ${subtleFieldCue(isCasino, cueBumperSceneOk)}`}>
                    <FieldLabel icon={Film}>Начальная сцена (видео, опционально)</FieldLabel>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={props.bumperPath}
                        className={previewFieldClass(previewMissingFields.includes('bumperVideo'))}
                      />
                      <button
                        type="button"
                        title="Выбрать файл"
                        onClick={async () => {
                          const p = await window.electronAPI.dialog.openFile({
                            filters: [{ name: 'Видео', extensions: ['mp4', 'mov', 'mkv', 'webm'] }]
                          })
                          if (p) props.setBumperPath(p)
                        }}
                        className="inline-flex shrink-0 items-center justify-center rounded-md border border-industrial-border/80 px-2 py-1 text-industrial-muted hover:bg-industrial-raised"
                      >
                        <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                      </button>
                    </div>
                  </label>
                  <label className={`flex min-w-0 flex-col gap-1 ${subtleFieldCue(isCasino, cueBumperSceneOk)}`}>
                    <FieldLabel icon={ImageIcon}>Оверлей начальной сцены (GIF, JPG, PNG, WebP… или видео)</FieldLabel>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={props.bumperOverlayPath}
                        className={previewFieldClass(previewMissingFields.includes('bumperOverlay'))}
                      />
                      <button
                        type="button"
                        title="Выбрать файл"
                        onClick={async () => {
                          const p = await window.electronAPI.dialog.openFile({
                            filters: [
                              {
                                name: 'Изображение или видео',
                                extensions: [...OVERLAY_IMAGE_EXTENSIONS, ...OVERLAY_VIDEO_EXTENSIONS]
                              }
                            ]
                          })
                          if (p) props.setBumperOverlayPath(p)
                        }}
                        className="inline-flex shrink-0 items-center justify-center rounded-md border border-industrial-border/80 px-2 py-1 text-industrial-muted hover:bg-industrial-raised"
                      >
                        <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                      </button>
                    </div>
                  </label>
                <label className="inline-flex cursor-pointer items-center gap-2 text-industrial-muted hover:text-industrial-text">
                  <input
                    type="checkbox"
                    checked={props.bumperMuteAudio}
                    onChange={(e) => props.setBumperMuteAudio(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-industrial-border bg-industrial-bg text-industrial-muted focus:ring-1 focus:ring-industrial-border"
                  />
                  <VolumeX className="h-3.5 w-3.5 shrink-0 text-industrial-dim" strokeWidth={1.5} aria-hidden />
                  <span>Замутить звук</span>
                </label>
                <div className="flex flex-col gap-2">
                  <FieldLabel icon={Timer}>Как долго крутить начальную сцену перед стримом?</FieldLabel>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={props.bumperPadMode}
                      onChange={(e) => props.setBumperPadMode(e.target.value as 'legacy' | 'once' | 'custom')}
                      className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
                    >
                      <option value="legacy">Авто (до 3 мин, если ролик короче 3 мин)</option>
                      <option value="once">Один проигрыв — по длине файла</option>
                      <option value="custom">Задать длительность</option>
                    </select>
                    {props.bumperPadMode === 'custom' ? (
                      <>
                        <select
                          value={String(props.bumperPadAmount)}
                          onChange={(e) => props.setBumperPadAmount(Number(e.target.value))}
                          className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
                        >
                          {!BUMPER_AMOUNT_OPTIONS_MIN.includes(props.bumperPadAmount) ? (
                            <option value={String(props.bumperPadAmount)}>{props.bumperPadAmount} (из сохранённых)</option>
                          ) : null}
                          {BUMPER_AMOUNT_OPTIONS_MIN.map((n) => (
                            <option key={n} value={String(n)}>
                              {n}
                            </option>
                          ))}
                        </select>
                        <span className="text-industrial-dim">минут</span>
                      </>
                    ) : null}
                  </div>
                </div>
                </div>
              </>
            ) : null}
            <ContentSubdivider icon={RadioTower} label="Стрим" />
            <div className="md:col-span-2 space-y-3 rounded-lg bg-industrial-bg/10 p-3 pl-4">
              <label className={`flex min-w-0 flex-col gap-1 ${subtleFieldCue(true, true)}`}>
                <FieldLabel icon={Layers}>Тип стрима</FieldLabel>
                <select
                  value={props.streamType}
                  onChange={(e) => props.setStreamType(e.target.value === 'white_prewarm' ? 'white_prewarm' : 'casino')}
                  className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
                >
                  <option value="casino">Казино</option>
                  <option value="white_prewarm">Прогрев белым</option>
                </select>
              </label>
              {props.streamType === 'casino' ? (
                <label className={`flex min-w-0 flex-col gap-1 ${subtleFieldCue(true, true)}`}>
                  <FieldLabel icon={Shuffle}>Режим стрима</FieldLabel>
                  <select
                    value={props.streamMode}
                    onChange={(e) =>
                      props.setStreamMode(
                        e.target.value === 'ordered' || e.target.value === 'single' ? e.target.value : 'random'
                      )
                    }
                    className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
                  >
                    <option value="random">Рандомный микс кусков</option>
                    <option value="ordered">Куски по порядку (1.mp4, 2.mp4, ...)</option>
                    <option value="single">Один кусок (выбранный mp4 файл)</option>
                  </select>
                </label>
              ) : (
                <label className={`flex min-w-0 flex-col gap-1 ${subtleFieldCue(true, true)}`}>
                  <FieldLabel icon={Sparkles}>Режим стрима</FieldLabel>
                  <div className="rounded border border-industrial-border bg-industrial-bg px-2 py-1.5 text-industrial-dim">
                    Один выбранный кусок в цикле (как «single», но отдельным типом).
                  </div>
                </label>
              )}
              <div>
                <button
                  type="button"
                  onClick={() => void invokeOpenPreview('stream')}
                  className="inline-flex items-center gap-2 rounded-md border border-industrial-border/80 bg-industrial-bg px-3 py-1.5 text-xs text-industrial-text hover:border-industrial-muted hover:bg-industrial-raised/30"
                >
                  <MonitorPlay className="h-3.5 w-3.5 text-industrial-dim" strokeWidth={1.5} aria-hidden />
                  Предпросмотр стрима
                </button>
              </div>
              <label className={`flex min-w-0 flex-col gap-1 ${subtleFieldCue(true, cueStreamSourceOk)}`}>
                <FieldLabel icon={effectiveStreamMode === 'single' ? FileVideo : FolderOpen}>
                  {effectiveStreamMode === 'single' ? 'Файл куска (.mp4)' : 'Папка с кусками стрима'}
                </FieldLabel>
                {effectiveStreamMode === 'ordered' ? (
                  <span className="text-[10px] text-industrial-dim">
                    Порядок берётся по имени файла в естественной сортировке: 1.mp4, 2.mp4, 10.mp4.
                  </span>
                ) : null}
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={effectiveStreamMode === 'single' ? props.singleSegmentPath : props.segmentsDir}
                    className={previewFieldClass(previewMissingFields.includes('streamSource'))}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      if (effectiveStreamMode === 'single') {
                        const p = await window.electronAPI.dialog.openFile({
                          filters: [{ name: 'Видео', extensions: ['mp4'] }]
                        })
                        if (p) props.setSingleSegmentPath(p)
                      } else {
                        const p = await window.electronAPI.dialog.openDirectory()
                        if (p) props.setSegmentsDir(p)
                      }
                    }}
                    title={effectiveStreamMode === 'single' ? 'Выбрать файл' : 'Выбрать папку'}
                    className="inline-flex shrink-0 items-center justify-center rounded-md border border-industrial-border/80 px-2 py-1 text-industrial-muted hover:bg-industrial-raised"
                  >
                    <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                  </button>
                </div>
              </label>
              {props.streamType === 'casino' ? (
                <label className={`flex min-w-0 flex-col gap-1 ${subtleFieldCue(isCasino, cueStreamOverlayOk)}`}>
                  <FieldLabel icon={ImageIcon}>
                  Оверлей (GIF, JPG, PNG, WebP, TIFF… или зацикленное видео MP4/MOV/…)
                </FieldLabel>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={props.overlayPath}
                      className={previewFieldClass(previewMissingFields.includes('streamOverlay'))}
                    />
                    <button
                      type="button"
                      title="Выбрать файл"
                      onClick={async () => {
                        const p = await window.electronAPI.dialog.openFile({
                          filters: [
                            {
                              name: 'Изображение или видео',
                              extensions: [...OVERLAY_IMAGE_EXTENSIONS, ...OVERLAY_VIDEO_EXTENSIONS]
                            }
                          ]
                        })
                        if (p) props.setOverlayPath(p)
                      }}
                      className="inline-flex shrink-0 items-center justify-center rounded-md border border-industrial-border/80 px-2 py-1 text-industrial-muted hover:bg-industrial-raised"
                    >
                      <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                    </button>
                  </div>
                </label>
              ) : null}
              {props.streamType === 'casino' ? (
                <div className="rounded border border-industrial-border/60 bg-industrial-bg/20 p-2.5">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={!canPrebakeMain || props.prebakeStatus.phase === 'running'}
                      onClick={() => void props.onPrebakeStart()}
                      className="inline-flex items-center gap-2 rounded-md border border-industrial-border/80 bg-industrial-bg px-3 py-1.5 text-xs text-industrial-text hover:border-industrial-muted hover:bg-industrial-raised/30 disabled:opacity-50"
                      title="Подготовить предзапечённый main-файл заранее (до старта эфира)"
                    >
                      <Clapperboard className="h-3.5 w-3.5 text-industrial-dim" strokeWidth={1.5} aria-hidden />
                      Pre-bake main
                    </button>
                    <button
                      type="button"
                      disabled={!canPrebakeMain || props.prebakeStatus.phase === 'running'}
                      onClick={() => void props.onPrebakeRebuild()}
                      className="inline-flex items-center gap-2 rounded-md border border-industrial-border/80 bg-industrial-bg px-3 py-1.5 text-xs text-industrial-text hover:border-industrial-muted hover:bg-industrial-raised/30 disabled:opacity-50"
                      title="Принудительно пересобрать pre-bake, игнорируя кэш"
                    >
                      Пересобрать
                    </button>
                    <button
                      type="button"
                      disabled={props.prebakeStatus.phase !== 'running'}
                      onClick={() => void props.onPrebakeCancel()}
                      className="inline-flex items-center gap-2 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-1.5 text-xs text-red-200 hover:bg-red-950/35 disabled:opacity-50"
                      title="Остановить текущий pre-bake"
                    >
                      Отмена
                    </button>
                    <span className="text-[10px] text-industrial-dim">
                      {props.prebakeStatus.phase === 'running'
                        ? 'Идёт подготовка...'
                        : props.prebakeStatus.phase === 'done'
                          ? props.prebakeStatus.cacheHit
                            ? 'Готово (из кэша)'
                            : 'Готово'
                          : props.prebakeStatus.phase === 'error'
                            ? 'Ошибка pre-bake'
                            : 'Не запускался'}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded bg-industrial-border/50">
                    <div
                      className={`h-full transition-all ${
                        props.prebakeStatus.phase === 'error'
                          ? 'bg-red-500/80'
                          : props.prebakeStatus.phase === 'done'
                            ? 'bg-emerald-500/80'
                            : 'bg-blue-500/80'
                      }`}
                      style={{ width: `${Math.max(0, Math.min(100, props.prebakeStatus.percent || 0))}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] text-industrial-dim">
                    {props.prebakeStatus.message || 'Нажмите кнопку, чтобы подготовить main заранее и не рвать эфир.'}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-industrial-border/60 bg-industrial-panel/30 p-3 md:p-4 shadow-sm shadow-black/20">
          <SectionTitle icon={Volume2}>Фоновая музыка</SectionTitle>
          <p className="mb-3 text-[10px] text-industrial-dim">
            Треки из папки идут в случайном порядке; коэффициент громкости одинаков для всех файлов. Громкость дублируется
            в окне предпросмотра и синхронизируется с этой формой.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-lg bg-industrial-bg/10 p-3">
              <div className="text-[11px] font-medium text-industrial-muted">В эфире стрима</div>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-industrial-dim">Папка с треками</span>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={props.streamMusicFolder}
                    className="min-w-0 flex-1 border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
                  />
                  <button
                    type="button"
                    title="Выбрать папку"
                    onClick={async () => {
                      const p = await window.electronAPI.dialog.openDirectory()
                      if (p) props.setStreamMusicFolder(p)
                    }}
                    className="inline-flex shrink-0 items-center justify-center rounded-md border border-industrial-border/80 px-2 py-1 text-industrial-muted hover:bg-industrial-raised"
                  >
                    <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                  </button>
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-industrial-dim">Громкость фона: {props.streamMusicVol}%</span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={props.streamMusicVol}
                  onChange={(e) => props.setStreamMusicVol(Number(e.target.value))}
                  className="w-full"
                />
              </label>
            </div>
            {props.streamType === 'casino' ? (
              <div className="space-y-2 rounded-lg bg-industrial-bg/10 p-3">
                <div className="text-[11px] font-medium text-industrial-muted">В начальной сцене</div>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-industrial-dim">Папка с треками</span>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={props.bumperMusicFolder}
                      className="min-w-0 flex-1 border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
                    />
                    <button
                      type="button"
                      title="Выбрать папку"
                      onClick={async () => {
                        const p = await window.electronAPI.dialog.openDirectory()
                        if (p) props.setBumperMusicFolder(p)
                      }}
                      className="inline-flex shrink-0 items-center justify-center rounded-md border border-industrial-border/80 px-2 py-1 text-industrial-muted hover:bg-industrial-raised"
                    >
                      <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                    </button>
                  </div>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-industrial-dim">Громкость фона: {props.bumperMusicVol}%</span>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    value={props.bumperMusicVol}
                    onChange={(e) => props.setBumperMusicVol(Number(e.target.value))}
                    className="w-full"
                  />
                </label>
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border border-industrial-border/60 bg-industrial-panel/30 p-3 md:p-4 shadow-sm shadow-black/20">
          <SectionTitle icon={SlidersHorizontal}>Кодирование</SectionTitle>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 md:col-span-2">
              <FieldLabel icon={Activity}>Настройки видеобитрейта</FieldLabel>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px]">
                <select
                  value={props.videoBitrateMode}
                  onChange={(e) => props.setVideoBitrateMode(e.target.value === 'vbr' ? 'vbr' : 'cbr')}
                  className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
                >
                  <option value="cbr">CBR (постоянный, как сейчас)</option>
                  <option value="vbr">VBR (переменный)</option>
                </select>
                <input
                  value={String(props.videoBitrateKbps)}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    props.setVideoBitrateKbps(Number.isFinite(n) ? n : 6000)
                  }}
                  inputMode="numeric"
                  className="border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
                  placeholder="6000"
                />
              </div>
              <span className="text-[10px] text-industrial-dim">
                Целевой видео-битрейт в kbps. По умолчанию: CBR 6000.
              </span>
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:col-span-2">
              <label className="flex flex-col gap-1">
                <FieldLabel icon={Video}>Разрешение кадра (Shorts)</FieldLabel>
                <select
                  value={props.streamOutputPreset}
                  onChange={(e) => props.setStreamOutputPreset(e.target.value as StreamOutputPreset)}
                  className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
                >
                  <option value="1080x1920">1080×1920</option>
                  <option value="900x1600">900×1600</option>
                  <option value="720x1280">720×1280</option>
                </select>
                <span className="text-[10px] text-industrial-dim">Вертикальный выход для RTMP и предпросмотра.</span>
              </label>
              <label className="flex flex-col gap-1">
                <FieldLabel icon={Sparkles}>Частота кадров (FPS)</FieldLabel>
                <select
                  value={String(props.streamVideoFps)}
                  onChange={(e) => props.setStreamVideoFps(Number(e.target.value))}
                  className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
                >
                  {STREAM_VIDEO_FPS_OPTIONS_UI.map((n) => (
                    <option key={n} value={String(n)}>
                      {n}
                    </option>
                  ))}
                </select>
                <span className="text-[10px] text-industrial-dim">GOP и keyint подстраиваются под выбранный FPS.</span>
              </label>
            </div>
            <label className="flex flex-col gap-1 md:col-span-2">
              <FieldLabel icon={Terminal}>Доп. аргументы ffmpeg (вставляются перед -f flv)</FieldLabel>
              <input
                value={props.ffmpegExtra}
                onChange={(e) => props.setFfmpegExtra(e.target.value)}
                className="border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
              />
            </label>
          </div>
        </section>
      </div>

      <div className="mt-4 border-t border-industrial-border pt-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-industrial-muted">
          <Video className="h-3.5 w-3.5" strokeWidth={1.5} />
          Метаданные эфира (YouTube Live)
        </div>
        <div className="grid max-w-3xl grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="text-industrial-muted">Broadcast ID</span>
            <p className="text-[10px] leading-snug text-industrial-dim">
              Подставляется с YouTube автоматически при каждом старте стрима и перед каждым новым циклом. Поле можно
              править вручную или обновить кнопкой ниже.
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                value={props.broadcastId}
                onChange={(e) => props.setBroadcastId(e.target.value)}
                placeholder="подставится автоматически"
                className="min-w-[12rem] flex-1 border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
              />
              {props.editId != null ? (
                <button
                  type="button"
                  disabled={suggestBusy || saving || applyBusy}
                  onClick={async () => {
                    setSuggestBusy(true)
                    props.setError(null)
                    try {
                      const r = await window.electronAPI.streamers.suggestBroadcastId({ streamerId: props.editId })
                      if (!r.ok) {
                        props.setError(r.error)
                        return
                      }
                      props.setBroadcastId(r.data.broadcastId)
                      await props.onMetaApplied()
                    } finally {
                      setSuggestBusy(false)
                    }
                  }}
                  className="shrink-0 border border-industrial-border px-2 py-1.5 text-[11px] hover:bg-industrial-raised disabled:opacity-50"
                >
                  {suggestBusy ? '…' : 'Обновить с YouTube'}
                </button>
              ) : null}
            </div>
          </label>
          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="text-industrial-muted">Название</span>
            <input
              value={props.bTitle}
              onChange={(e) => props.setBTitle(e.target.value)}
              className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="text-industrial-muted">Описание</span>
            <textarea
              value={props.bDesc}
              onChange={(e) => props.setBDesc(e.target.value)}
              rows={3}
              className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="text-industrial-muted">Теги (через запятую)</span>
            <input
              value={props.bTags}
              onChange={(e) => props.setBTags(e.target.value)}
              className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-industrial-muted">Доступ</span>
            <select
              value={props.bPrivacy}
              onChange={(e) => props.setBPrivacy(e.target.value as 'private' | 'public' | 'unlisted')}
              className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
            >
              <option value="private">Приватный (только вы)</option>
              <option value="unlisted">По ссылке (не в поиске и подписках)</option>
              <option value="public">Открытый (все могут найти)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-industrial-muted">Категория</span>
            <select
              value={categorySelectValue}
              onChange={(e) => props.setBCategory(e.target.value)}
              className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
            >
              {categoryShowLegacy ? (
                <option value={categoryRaw}>Сохранённое значение (ID {categoryRaw})</option>
              ) : null}
              {YOUTUBE_VIDEO_CATEGORY_OPTIONS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 md:col-span-2">
            <span className="text-industrial-muted">Превью эфира (локальный файл)</span>
            <p className="text-[10px] leading-snug text-industrial-dim">
              JPG / PNG / WebP с диска. Загружается на YouTube при «Применить метаданные», если есть id ролика эфира
              (bound video или тот же id, что у эфира, upcoming/live). На канале должны быть разрешены свои превью;
              картинка обычно 1280×720.
            </p>
            <div className="flex gap-2">
              <input
                readOnly
                value={props.bThumbPath}
                className="min-w-0 flex-1 border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
              />
              <button
                type="button"
                onClick={async () => {
                  const p = await window.electronAPI.dialog.openFile({
                    filters: [{ name: 'Изображение', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
                  })
                  if (p) props.setBThumbPath(p)
                }}
                className="shrink-0 border border-industrial-border px-2 py-1 hover:bg-industrial-raised"
              >
                …
              </button>
            </div>
          </label>
        </div>
        {props.editId != null ? (
          <button
            type="button"
            disabled={applyBusy || saving}
            onClick={async () => {
              setApplyBusy(true)
              props.setError(null)
              setApplyDebugLog(null)
              try {
                const r = await window.electronAPI.streamers.applyBroadcastMeta({
                  streamerId: props.editId,
                  youtube_broadcast_id: props.broadcastId.trim() || null,
                  broadcast_title: props.bTitle.trim() || null,
                  broadcast_description: props.bDesc.trim() || null,
                  broadcast_tags: props.bTags.trim() || null,
                  broadcast_privacy: props.bPrivacy,
                  broadcast_category_id: props.bCategory.trim() || '22',
                  broadcast_thumb_path: props.bThumbPath.trim() || null
                })
                if (!r.ok) {
                  props.setError(r.error)
                  setApplyDebugLog(r.debugLog ?? null)
                } else {
                  setApplyDebugLog(r.data.debugLog)
                  await props.onMetaApplied()
                }
              } finally {
                setApplyBusy(false)
              }
            }}
            className="mt-3 border border-industrial-border px-3 py-1.5 text-[11px] hover:bg-industrial-raised disabled:opacity-50"
          >
            {applyBusy ? '…' : 'Применить метаданные к эфиру'}
          </button>
        ) : null}
        {applyDebugLog ? (
          <div className="mt-3 max-w-3xl border border-industrial-border bg-industrial-bg/80 p-2">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] text-industrial-muted">
                Ответ API (временно, для отладки — скопируйте целиком при обращении)
              </span>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(applyDebugLog)}
                className="border border-industrial-border px-2 py-0.5 text-[10px] hover:bg-industrial-raised"
              >
                Скопировать
              </button>
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-industrial-dim">
              {applyDebugLog}
            </pre>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-raised px-4 py-2 text-xs hover:bg-industrial-panel disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Сохранить
        </button>
      </div>
    </form>
  )
}
