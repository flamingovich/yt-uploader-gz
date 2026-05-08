import { ExternalLink, Loader2, Play, Square, Trash2, Video } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  isKnownYoutubeVideoCategoryId,
  YOUTUBE_VIDEO_CATEGORY_OPTIONS
} from '../constants/youtubeVideoCategories'

type StreamerRow = StreamerListItem
type ChannelRow = Awaited<ReturnType<typeof window.electronAPI.db.listChannels>>[number]
type ProxyRow = Awaited<ReturnType<typeof window.electronAPI.db.listProxies>>[number]

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
  const [streamMode, setStreamMode] = useState<'random' | 'ordered' | 'single'>('random')
  const [segmentsDir, setSegmentsDir] = useState('')
  const [singleSegmentPath, setSingleSegmentPath] = useState('')
  const [bumperPath, setBumperPath] = useState('')
  const [overlayPath, setOverlayPath] = useState('')
  const [videoBitrateKbps, setVideoBitrateKbps] = useState(6000)
  const [videoBitrateMode, setVideoBitrateMode] = useState<'cbr' | 'vbr'>('cbr')
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
      void reload()
    })
    return unsubscribe
  }, [reload])

  function resetForm(): void {
    setEditId(null)
    setName('')
    setChannelId('')
    setProxyId('inherit')
    setIngest('rtmp://a.rtmp.youtube.com/live2')
    setStreamKey('')
    setStreamMode('random')
    setSegmentsDir('')
    setSingleSegmentPath('')
    setBumperPath('')
    setOverlayPath('')
    setVideoBitrateKbps(6000)
    setVideoBitrateMode('cbr')
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
      setStreamMode(r.stream_mode === 'ordered' || r.stream_mode === 'single' ? r.stream_mode : 'random')
      setSegmentsDir(r.segments_folder_path ?? '')
      setSingleSegmentPath(r.single_segment_path ?? '')
      setBumperPath(r.bumper_video_path ?? '')
      setOverlayPath(r.overlay_path ?? '')
      setVideoBitrateKbps(
        Number.isFinite(Number(r.video_bitrate_kbps)) ? Math.max(200, Number(r.video_bitrate_kbps)) : 6000
      )
      setVideoBitrateMode(r.video_bitrate_mode === 'vbr' ? 'vbr' : 'cbr')
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
        <button
          type="button"
          onClick={() => openCreate()}
          className="border border-industrial-border bg-industrial-raised px-3 py-1.5 text-xs text-industrial-text hover:bg-industrial-panel"
        >
          + Стример
        </button>
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
          streamMode={streamMode}
          setStreamMode={setStreamMode}
          segmentsDir={segmentsDir}
          setSegmentsDir={setSegmentsDir}
          singleSegmentPath={singleSegmentPath}
          setSingleSegmentPath={setSingleSegmentPath}
          bumperPath={bumperPath}
          setBumperPath={setBumperPath}
          overlayPath={overlayPath}
          setOverlayPath={setOverlayPath}
          videoBitrateKbps={videoBitrateKbps}
          setVideoBitrateKbps={setVideoBitrateKbps}
          videoBitrateMode={videoBitrateMode}
          setVideoBitrateMode={setVideoBitrateMode}
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
        <table className="w-full min-w-[880px] border-collapse text-left text-xs">
          <thead className="bg-industrial-panel text-industrial-muted">
            <tr>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Название</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Канал</th>
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
              <tr key={r.id} className="border-b border-industrial-border/80 hover:bg-industrial-panel/40">
                <td className="px-2 py-2 font-medium">{r.name}</td>
                <td className="px-2 py-2 text-industrial-muted">{r.channel_title ?? `#${r.channel_id}`}</td>
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
                <td colSpan={9} className="px-3 py-6 text-center text-industrial-muted">
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
  streamMode: 'random' | 'ordered' | 'single'
  setStreamMode: (v: 'random' | 'ordered' | 'single') => void
  segmentsDir: string
  setSegmentsDir: (v: string) => void
  singleSegmentPath: string
  setSingleSegmentPath: (v: string) => void
  bumperPath: string
  setBumperPath: (v: string) => void
  overlayPath: string
  setOverlayPath: (v: string) => void
  videoBitrateKbps: number
  setVideoBitrateKbps: (v: number) => void
  videoBitrateMode: 'cbr' | 'vbr'
  setVideoBitrateMode: (v: 'cbr' | 'vbr') => void
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
          segments_folder_path: props.streamMode === 'single' ? null : props.segmentsDir.trim() || null,
          stream_mode: props.streamMode,
          single_segment_path: props.streamMode === 'single' ? props.singleSegmentPath.trim() || null : null,
          bumper_video_path: props.bumperPath.trim() || null,
          overlay_path: props.overlayPath.trim() || null,
          video_bitrate_kbps: Math.max(200, Math.min(50000, Math.floor(props.videoBitrateKbps || 6000))),
          video_bitrate_mode: props.videoBitrateMode,
          ffmpeg_extra_args: props.ffmpegExtra.trim() || null,
          youtube_broadcast_id: props.broadcastId.trim() || null,
          broadcast_title: props.bTitle.trim() || null,
          broadcast_description: props.bDesc.trim() || null,
          broadcast_tags: props.bTags.trim() || null,
          broadcast_privacy: props.bPrivacy,
          broadcast_category_id: props.bCategory.trim() || '22',
          broadcast_thumb_path: props.bThumbPath.trim() || null,
          bumper_pad_target_sec: bumperPadTargetSecFromForm(props),
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
          segments_folder_path: props.streamMode === 'single' ? null : props.segmentsDir.trim() || null,
          stream_mode: props.streamMode,
          single_segment_path: props.streamMode === 'single' ? props.singleSegmentPath.trim() || null : null,
          bumper_video_path: props.bumperPath.trim() || null,
          overlay_path: props.overlayPath.trim() || null,
          video_bitrate_kbps: Math.max(200, Math.min(50000, Math.floor(props.videoBitrateKbps || 6000))),
          video_bitrate_mode: props.videoBitrateMode,
          ffmpeg_extra_args: props.ffmpegExtra.trim() || null,
          youtube_broadcast_id: props.broadcastId.trim() || null,
          broadcast_title: props.bTitle.trim() || null,
          broadcast_description: props.bDesc.trim() || null,
          broadcast_tags: props.bTags.trim() || null,
          broadcast_privacy: props.bPrivacy,
          broadcast_category_id: props.bCategory.trim() || '22',
          broadcast_thumb_path: props.bThumbPath.trim() || null,
          bumper_pad_target_sec: bumperPadTargetSecFromForm(props),
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

      <div className="grid max-w-3xl grid-cols-1 gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-industrial-muted">Название</span>
          <input
            value={props.name}
            onChange={(e) => props.setName(e.target.value)}
            className="border border-industrial-border bg-industrial-bg px-2 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-industrial-muted">Канал (OAuth)</span>
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
          <span className="text-industrial-muted">Прокси для RTMP (пусто = как у канала)</span>
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
          <span className="text-industrial-muted">RTMP ingest URL</span>
          <input
            value={props.ingest}
            onChange={(e) => props.setIngest(e.target.value)}
            className="border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
          />
        </label>
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-industrial-muted">Stream key (из YouTube Studio)</span>
          <input
            value={props.streamKey}
            onChange={(e) => props.setStreamKey(e.target.value)}
            className="border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
          />
        </label>
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-industrial-muted">Режим стрима</span>
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
        <div className="md:col-span-2">
          <button
            type="button"
            onClick={async () => {
              props.setError(null)
              const r = await window.electronAPI.streamers.openPreview({
                channel_id: props.channelId === '' ? undefined : props.channelId,
                stream_mode: props.streamMode,
                segments_folder_path: props.segmentsDir.trim() || null,
                single_segment_path: props.singleSegmentPath.trim() || null,
                overlay_path: props.overlayPath.trim() || null,
                bumper_video_path: props.bumperPath.trim() || null,
                video_bitrate_kbps: Math.max(200, Math.min(50000, Math.floor(props.videoBitrateKbps || 6000))),
                video_bitrate_mode: props.videoBitrateMode,
                ffmpeg_extra_args: props.ffmpegExtra.trim() || null
              })
              if (!r.ok) props.setError(r.error)
            }}
            className="border border-industrial-border bg-industrial-bg px-3 py-1.5 text-xs text-industrial-text hover:border-industrial-muted"
          >
            Предпросмотр стрима
          </button>
        </div>
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-industrial-muted">
            {props.streamMode === 'single' ? 'Файл куска (.mp4)' : 'Папка с кусками (видео)'}
          </span>
          {props.streamMode === 'ordered' ? (
            <span className="text-[10px] text-industrial-dim">
              Порядок берётся по имени файла в естественной сортировке: 1.mp4, 2.mp4, 10.mp4.
            </span>
          ) : null}
          <div className="flex gap-2">
            <input
              readOnly
              value={props.streamMode === 'single' ? props.singleSegmentPath : props.segmentsDir}
              className="min-w-0 flex-1 border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
            />
            <button
              type="button"
              onClick={async () => {
                if (props.streamMode === 'single') {
                  const p = await window.electronAPI.dialog.openFile({
                    filters: [{ name: 'Видео', extensions: ['mp4'] }]
                  })
                  if (p) props.setSingleSegmentPath(p)
                } else {
                  const p = await window.electronAPI.dialog.openDirectory()
                  if (p) props.setSegmentsDir(p)
                }
              }}
              className="shrink-0 border border-industrial-border px-2 py-1 hover:bg-industrial-raised"
            >
              …
            </button>
          </div>
        </label>
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-industrial-muted">Заглушка перед циклом (один раз за сессию старта)</span>
          <div className="flex gap-2">
            <input
              readOnly
              value={props.bumperPath}
              className="min-w-0 flex-1 border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
            />
            <button
              type="button"
              onClick={async () => {
                const p = await window.electronAPI.dialog.openFile({
                  filters: [{ name: 'Видео', extensions: ['mp4', 'mov', 'mkv', 'webm'] }]
                })
                if (p) props.setBumperPath(p)
              }}
              className="shrink-0 border border-industrial-border px-2 py-1 hover:bg-industrial-raised"
            >
              …
            </button>
          </div>
          <div className="mt-2 flex flex-col gap-2 rounded border border-industrial-border/60 bg-industrial-bg/40 p-2">
            <span className="text-[10px] text-industrial-dim">
              Как долго крутить заглушку перед основным циклом. Таймер задаётся в минутах.
            </span>
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
        </label>
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-industrial-muted">Оверлей (PNG/WebP или зацикленное видео MP4/MOV/…)</span>
          <div className="flex gap-2">
            <input
              readOnly
              value={props.overlayPath}
              className="min-w-0 flex-1 border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
            />
            <button
              type="button"
              onClick={async () => {
                const p = await window.electronAPI.dialog.openFile({
                  filters: [
                    {
                      name: 'Изображение или видео',
                      extensions: ['png', 'webp', 'apng', 'mp4', 'mov', 'webm', 'mkv']
                    }
                  ]
                })
                if (p) props.setOverlayPath(p)
              }}
              className="shrink-0 border border-industrial-border px-2 py-1 hover:bg-industrial-raised"
            >
              …
            </button>
          </div>
        </label>
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-industrial-muted">Настройки видеобитрейта</span>
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
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-industrial-muted">Доп. аргументы ffmpeg (вставляются перед -f flv)</span>
          <input
            value={props.ffmpegExtra}
            onChange={(e) => props.setFfmpegExtra(e.target.value)}
            className="border border-industrial-border bg-industrial-bg px-2 py-1.5 font-mono text-[11px]"
          />
        </label>
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
