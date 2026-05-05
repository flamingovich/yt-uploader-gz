import {
  AlertCircle,
  AlertTriangle,
  BadgeCheck,
  ArrowLeftRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FolderOpen,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  isListedScheduleTimezone,
  sortedScheduleTimezones,
  timezoneSelectLabel
} from '../lib/timezones'
import { collectFuturePublishCandidates } from '@services/schedule/publishSchedule'
import { ProxyStatusGlyph } from '../lib/proxyCheckDisplay'

type ChannelRow = Awaited<ReturnType<typeof window.electronAPI.db.listChannels>>[number]
type ProxyRow = Awaited<ReturnType<typeof window.electronAPI.db.listProxies>>[number]
type OAuthProfileRow = Awaited<ReturnType<typeof window.electronAPI.db.listOAuthProfiles>>[number]
type CreateChannelResult = Awaited<ReturnType<typeof window.electronAPI.db.createChannel>>
type BeginManualResult = Awaited<ReturnType<typeof window.electronAPI.db.oauthBeginManual>>
type BeginManualInAdsResult = Awaited<ReturnType<typeof window.electronAPI.db.oauthBeginManualInAds>>
type SyncProxyFromAdsResult = Awaited<ReturnType<typeof window.electronAPI.db.syncProxyFromAds>>
type WaitManualResult = Awaited<ReturnType<typeof window.electronAPI.db.oauthWaitManual>>
type FinishManualResult = Awaited<ReturnType<typeof window.electronAPI.db.oauthFinishManual>>
type GenerateMetaResult = Awaited<ReturnType<typeof window.electronAPI.ai.generateChannelMeta>>
type UploadResult = Awaited<ReturnType<typeof window.electronAPI.db.uploadTestVideo>>
type UpdatePublishingResult = Awaited<ReturnType<typeof window.electronAPI.db.updateChannelPublishing>>
type DeleteChannelResult = Awaited<ReturnType<typeof window.electronAPI.db.deleteChannel>>
type ChannelsSortField = 'ads' | 'lastVideoDate'
type ChannelsSortDir = 'asc' | 'desc'

const CATEGORY_OPTIONS = [
  { id: '22', label: 'People & Blogs' },
  { id: '24', label: 'Entertainment' },
  { id: '27', label: 'Education' },
  { id: '28', label: 'Science & Technology' },
  { id: '10', label: 'Music' },
  { id: '20', label: 'Gaming' }
]

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function toDateTimeLocalValue(value: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Календарный день (YYYY-MM-DD) в указанной IANA-зоне. */
function calendarDayInTimeZone(isoLike: string, timeZone: string): string | null {
  const d = new Date(isoLike)
  if (Number.isNaN(d.getTime())) return null
  const tz = timeZone.trim() || 'UTC'
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d)
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d)
  }
}

function calendarDaysBetweenYmd(activityYmd: string, todayYmd: string): number {
  const [ya, ma, da] = activityYmd.split('-').map(Number)
  const [yb, mb, db] = todayYmd.split('-').map(Number)
  return Math.round((Date.UTC(ya, ma - 1, da) - Date.UTC(yb, mb - 1, db)) / 86400000)
}

/**
 * Насколько «вперёд» закрыта очередь по дате последней активности (публикация или отложка):
 * сравнение календарных дней в schedule_timezone канала.
 */
function queueBufferTier(
  lastQueueActivityAt: string | null,
  scheduleTimezone: string | null | undefined
): 'ok' | 'warn' | 'bad' | 'unknown' {
  if (!lastQueueActivityAt?.trim()) return 'unknown'
  const tz = (scheduleTimezone ?? 'Europe/Moscow').trim() || 'Europe/Moscow'
  const activityDay = calendarDayInTimeZone(lastQueueActivityAt.trim(), tz)
  const todayDay = calendarDayInTimeZone(new Date().toISOString(), tz)
  if (!activityDay || !todayDay) return 'unknown'
  const diff = calendarDaysBetweenYmd(activityDay, todayDay)
  if (diff <= 0) return 'bad'
  if (diff === 1) return 'warn'
  return 'ok'
}

function QueueBufferGlyph(props: { tier: 'ok' | 'warn' | 'bad' | 'unknown' }): JSX.Element {
  const common = 'h-4 w-4 shrink-0'
  if (props.tier === 'ok') {
    return (
      <span
        className="inline-flex"
        title="Запас по датам: минимум на 2 календарных дня вперёд (последняя активность очереди позже завтра)."
      >
        <CheckCircle2 className={`${common} text-emerald-400`} strokeWidth={2} aria-hidden />
      </span>
    )
  }
  if (props.tier === 'warn') {
    return (
      <span className="inline-flex" title="Запас по датам: только на 1 календарный день вперёд (завтра).">
        <AlertCircle className={`${common} text-amber-400`} strokeWidth={2} aria-hidden />
      </span>
    )
  }
  const warnTitle =
    props.tier === 'unknown'
      ? 'Нет данных по дате последней активности очереди — проверьте загрузки и отложенные публикации.'
      : 'Запас по датам: сегодня или уже в прошлом — нужно пополнить очередь.'
  return (
    <span className="inline-flex" title={warnTitle}>
      <AlertTriangle className={`${common} text-red-400`} strokeWidth={2} aria-hidden />
    </span>
  )
}

export function ChannelsPage(): JSX.Element {
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [proxies, setProxies] = useState<ProxyRow[]>([])
  const [oauthProfiles, setOauthProfiles] = useState<OAuthProfileRow[]>([])
  const [title, setTitle] = useState('')
  const [proxyId, setProxyId] = useState<number | ''>('')
  const [oauthProfileId, setOauthProfileId] = useState<number | ''>('')
  const [folder, setFolder] = useState<string | null>(null)
  const [adsProfileId, setAdsProfileId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [rowActionMsg, setRowActionMsg] = useState<string | null>(null)
  const [busyRow, setBusyRow] = useState<number | null>(null)
  const [manualFlow, setManualFlow] = useState<{ channelId: number; flowId: string; authUrl: string } | null>(null)
  const [manualCallbackUrl, setManualCallbackUrl] = useState('')
  const [manualAuthUrlCopied, setManualAuthUrlCopied] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingChannelId, setEditingChannelId] = useState<number | null>(null)
  const [editDescription, setEditDescription] = useState('')
  const [editTags, setEditTags] = useState('')
  const [editDescriptionMode, setEditDescriptionMode] = useState<'manual' | 'generate'>('manual')
  const [editTagsMode, setEditTagsMode] = useState<'manual' | 'generate'>('manual')
  const [editDescriptionPrompt, setEditDescriptionPrompt] = useState('')
  const [editTagsPrompt, setEditTagsPrompt] = useState('')
  const [editAiBusy, setEditAiBusy] = useState<'description' | 'tags' | null>(null)
  const [editMadeForKids, setEditMadeForKids] = useState(0)
  const [editCategoryId, setEditCategoryId] = useState('22')
  const [editLanguage, setEditLanguage] = useState('ru')
  const [editPublishMode, setEditPublishMode] = useState<'manual' | 'scheduled'>('manual')
  const [editScheduleStartAt, setEditScheduleStartAt] = useState('')
  const [editVideosPerDay, setEditVideosPerDay] = useState(4)
  const [editWindowStartHour, setEditWindowStartHour] = useState(9)
  const [editWindowEndHour, setEditWindowEndHour] = useState(23)
  const [editRandomizeMinutes, setEditRandomizeMinutes] = useState(45)
  const [editTimezone, setEditTimezone] = useState('Europe/Moscow')
  const [editSourceFolder, setEditSourceFolder] = useState<string | null>(null)
  const [editUploadCooldownSeconds, setEditUploadCooldownSeconds] = useState(20)
  const [editAdsProfileId, setEditAdsProfileId] = useState('')
  const [checkingProxyForChannelId, setCheckingProxyForChannelId] = useState<number | null>(null)
  const [sortField, setSortField] = useState<ChannelsSortField>('ads')
  const [sortDir, setSortDir] = useState<ChannelsSortDir>('asc')
  const editingChannel = editingChannelId ? channels.find((x) => x.id === editingChannelId) ?? null : null
  const scheduleTimezoneOptions = useMemo(() => sortedScheduleTimezones(), [])

  const sortedChannels = useMemo(() => {
    const rows = [...channels]
    rows.sort((a, b) => {
      if (sortField === 'ads') {
        const av = (a.ads_profile_name ?? '').trim().toLowerCase() || (a.ads_profile_id ?? '').trim().toLowerCase()
        const bv = (b.ads_profile_name ?? '').trim().toLowerCase() || (b.ads_profile_id ?? '').trim().toLowerCase()
        const cmp = av.localeCompare(bv, 'ru', { sensitivity: 'base' })
        return sortDir === 'asc' ? cmp : -cmp
      }
      const at = a.last_queue_activity_at ? new Date(a.last_queue_activity_at).getTime() : Number.NEGATIVE_INFINITY
      const bt = b.last_queue_activity_at ? new Date(b.last_queue_activity_at).getTime() : Number.NEGATIVE_INFINITY
      const safeA = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
      const safeB = Number.isFinite(bt) ? bt : Number.NEGATIVE_INFINITY
      return sortDir === 'asc' ? safeA - safeB : safeB - safeA
    })
    return rows
  }, [channels, sortDir, sortField])

  function toggleSort(field: ChannelsSortField): void {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortField(field)
    setSortDir('asc')
  }

  const previewTimes = useMemo(() => {
    if (editPublishMode !== 'scheduled') return []
    const now = new Date()
    const minFuture = new Date(now.getTime() + 60_000)
    const baseIso =
      editScheduleStartAt.trim() !== ''
        ? (() => {
            const parsed = new Date(editScheduleStartAt)
            return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
          })()
        : null
    return collectFuturePublishCandidates({
      baseIso,
      videosPerDay: editVideosPerDay,
      windowStartHour: editWindowStartHour,
      windowEndHour: editWindowEndHour,
      randomizeMinutes: editRandomizeMinutes,
      minFuture,
      needCount: 10,
      mode: 'preview'
    })
  }, [
    editPublishMode,
    editScheduleStartAt,
    editVideosPerDay,
    editWindowStartHour,
    editWindowEndHour,
    editRandomizeMinutes
  ])

  const reload = useCallback(async () => {
    const [c, p, o] = await Promise.all([
      window.electronAPI.db.listChannels(),
      window.electronAPI.db.listProxies(),
      window.electronAPI.db.listOAuthProfiles()
    ])
    setChannels(c)
    setProxies(p)
    setOauthProfiles(o)
    setProxyId((prev) => {
      if (prev === '') return ''
      if (typeof prev === 'number' && !p.some((x) => x.id === prev)) return ''
      return prev
    })
    setOauthProfileId((prev) => {
      if (prev === '') return ''
      if (typeof prev === 'number' && !o.some((x) => x.id === prev)) return ''
      return prev
    })
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

  async function pickFolder(): Promise<void> {
    const path = await window.electronAPI.dialog.openDirectory()
    setFolder(path)
  }

  async function pickEditFolder(): Promise<void> {
    const path = await window.electronAPI.dialog.openDirectory()
    if (path) setEditSourceFolder(path)
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    const res: CreateChannelResult = await window.electronAPI.db.createChannel({
      proxy_id: proxyId === '' ? null : proxyId,
      oauth_profile_id: oauthProfileId === '' ? null : oauthProfileId,
      ads_profile_id: adsProfileId.trim() || null,
      channel_title: title,
      source_folder_path: folder
    })
    if (!res.ok) {
      setError(res.error)
      return
    }
    setTitle('')
    setFolder(null)
    setAdsProfileId('')
    await reload()
  }

  async function beginManualConnect(channelId: number): Promise<void> {
    if (busyRow !== null) return
    setRowActionMsg(null)
    setBusyRow(channelId)
    try {
      const res: BeginManualResult = await window.electronAPI.db.oauthBeginManual({ channelId })
      if (!res.ok) {
        setRowActionMsg(`Ошибка генерации OAuth-ссылки: ${res.error}`)
        return
      }
      setManualAuthUrlCopied(false)
      setManualFlow({ channelId, flowId: res.data.flowId, authUrl: res.data.authUrl })
      setManualCallbackUrl('')
      setRowActionMsg(
        'Ссылка сгенерирована. Нажми «Скопировать ссылку», вставь в браузер с аккаунтом канала, затем вставь callback URL ниже.'
      )
    } finally {
      setBusyRow(null)
    }
  }

  async function beginManualConnectInAds(channelId: number): Promise<void> {
    if (busyRow !== null) return
    setRowActionMsg(null)
    setBusyRow(channelId)
    try {
      const res: BeginManualInAdsResult = await window.electronAPI.db.oauthBeginManualInAds({ channelId })
      if (!res.ok) {
        setRowActionMsg(`Ошибка запуска OAuth в ADS: ${res.error}`)
        return
      }
      setManualAuthUrlCopied(false)
      setManualFlow({ channelId, flowId: res.data.flowId, authUrl: res.data.authUrl })
      setManualCallbackUrl('')
      setRowActionMsg('Ссылка открыта в ADS. Жду автоматический callback после подтверждения доступа...')
      const waitRes: WaitManualResult = await window.electronAPI.db.oauthWaitManual({
        flowId: res.data.flowId,
        timeoutMs: 240000
      })
      if (!waitRes.ok) {
        setRowActionMsg(`Автозавершение не сработало: ${waitRes.error}`)
        return
      }
      setRowActionMsg(`Канал подключен автоматически: ${waitRes.data.channel_title}`)
      setManualFlow(null)
      setManualCallbackUrl('')
      setManualAuthUrlCopied(false)
      await reload()
    } finally {
      setBusyRow(null)
    }
  }

  async function syncProxyFromAds(channelId: number): Promise<void> {
    if (busyRow !== null) return
    setRowActionMsg(null)
    setBusyRow(channelId)
    try {
      const res: SyncProxyFromAdsResult = await window.electronAPI.db.syncProxyFromAds({ channelId })
      if (!res.ok) {
        setRowActionMsg(`Не удалось синхронизировать прокси из ADS: ${res.error}`)
        return
      }
      setRowActionMsg(res.data.summary)
      await reload()
    } finally {
      setBusyRow(null)
    }
  }

  async function finishManualConnect(): Promise<void> {
    if (!manualFlow || busyRow !== null) return
    setBusyRow(manualFlow.channelId)
    setRowActionMsg(null)
    try {
      const res: FinishManualResult = await window.electronAPI.db.oauthFinishManual({
        flowId: manualFlow.flowId,
        callbackUrl: manualCallbackUrl
      })
      if (!res.ok) {
        setRowActionMsg(`Ошибка ручного OAuth: ${res.error}`)
        return
      }
      setRowActionMsg(`Канал подключен вручную: ${res.data.channel_title}`)
      setManualFlow(null)
      setManualCallbackUrl('')
      setManualAuthUrlCopied(false)
      await reload()
    } finally {
      setBusyRow(null)
    }
  }

  async function uploadTest(channelId: number): Promise<void> {
    if (busyRow !== null) return
    setRowActionMsg(null)
    setBusyRow(channelId)
    try {
      const res: UploadResult = await window.electronAPI.db.uploadTestVideo({ channelId })
      if (!res.ok) {
        setRowActionMsg(`Ошибка загрузки: ${res.error}`)
        return
      }
      setRowActionMsg(
        `Загрузка завершена: успешно ${res.data.uploaded}, ошибок ${res.data.failed}, сегодня ${res.data.daily_used}/${res.data.daily_limit}`
      )
      await reload()
    } finally {
      setBusyRow(null)
    }
  }

  async function removeChannel(channelId: number): Promise<void> {
    if (busyRow !== null) return
    const ok = window.confirm('Удалить канал? Это также удалит его очередь загрузок.')
    if (!ok) return
    setBusyRow(channelId)
    setRowActionMsg(null)
    try {
      const res: DeleteChannelResult = await window.electronAPI.db.deleteChannel(channelId)
      if (!res.ok) {
        setRowActionMsg(`Ошибка удаления канала: ${res.error}`)
        return
      }
      setRowActionMsg('Канал удален')
      await reload()
    } finally {
      setBusyRow(null)
    }
  }

  function openEditor(ch: ChannelRow): void {
    setEditingChannelId(ch.id)
    setEditDescription(ch.default_description ?? '')
    setEditTags(ch.default_tags ?? '')
    setEditDescriptionMode('manual')
    setEditTagsMode('manual')
    setEditDescriptionPrompt(ch.channel_title ?? '')
    setEditTagsPrompt(ch.channel_title ?? '')
    setEditMadeForKids(ch.made_for_kids ? 1 : 0)
    setEditCategoryId(ch.default_category_id || '22')
    setEditLanguage(ch.default_language || 'ru')
    setEditPublishMode(ch.publish_mode === 'scheduled' ? 'scheduled' : 'manual')
    const queueNext =
      ch.next_scheduled_publish_at && ch.next_scheduled_publish_at.trim() !== ''
        ? ch.next_scheduled_publish_at
        : null
    const savedStart =
      ch.schedule_start_at && ch.schedule_start_at.trim() !== '' ? ch.schedule_start_at : null
    const startDefault = queueNext ?? savedStart
    setEditScheduleStartAt(toDateTimeLocalValue(startDefault))
    setEditVideosPerDay(ch.schedule_videos_per_day || 4)
    setEditWindowStartHour(ch.schedule_window_start_hour ?? 9)
    setEditWindowEndHour(ch.schedule_window_end_hour ?? 23)
    setEditRandomizeMinutes(ch.schedule_randomize_minutes ?? 45)
    setEditTimezone(ch.schedule_timezone || 'Europe/Moscow')
    setEditSourceFolder(ch.source_folder_path ?? null)
    setEditAdsProfileId(ch.ads_profile_id ?? '')
    setEditUploadCooldownSeconds(
      typeof ch.upload_cooldown_seconds === 'number' && Number.isFinite(ch.upload_cooldown_seconds)
        ? ch.upload_cooldown_seconds
        : 20
    )
    setEditorOpen(true)
  }

  async function generateMeta(kind: 'description' | 'tags'): Promise<void> {
    if (!editingChannelId || editAiBusy !== null || busyRow !== null) return
    const prompt = (kind === 'description' ? editDescriptionPrompt : editTagsPrompt).trim()
    if (!prompt) {
      setRowActionMsg(`Введите промт для ${kind === 'description' ? 'описания' : 'тегов'}`)
      return
    }
    setRowActionMsg(null)
    setEditAiBusy(kind)
    try {
      const categoryLabel = CATEGORY_OPTIONS.find((x) => x.id === editCategoryId)?.label ?? editCategoryId
      const res: GenerateMetaResult = await window.electronAPI.ai.generateChannelMeta({
        channelId: editingChannelId,
        kind,
        topicPrompt: prompt,
        language: editLanguage,
        category: categoryLabel,
        madeForKids: editMadeForKids === 1
      })
      if (!res.ok) {
        setRowActionMsg(`Ошибка AI генерации: ${res.error}`)
        return
      }
      if (kind === 'description') {
        setEditDescription(res.data.text)
      } else {
        setEditTags(res.data.text)
      }
      setRowActionMsg(kind === 'description' ? 'Описание сгенерировано' : 'Теги сгенерированы')
    } finally {
      setEditAiBusy(null)
    }
  }

  async function recheckChannelProxy(ch: ChannelRow, px: ProxyRow): Promise<void> {
    if (checkingProxyForChannelId !== null || busyRow !== null) return
    setCheckingProxyForChannelId(ch.id)
    setRowActionMsg(null)
    try {
      const r = await window.electronAPI.proxy.check({ persistId: px.id })
      if (!r.ok) setRowActionMsg(`Прокси: ${r.error}`)
      await reload()
    } finally {
      setCheckingProxyForChannelId(null)
    }
  }

  async function saveEditor(): Promise<void> {
    if (!editingChannelId || busyRow !== null) return
    setBusyRow(editingChannelId)
    setRowActionMsg(null)
    try {
      const parsedStart = editScheduleStartAt ? new Date(editScheduleStartAt) : null
      const startIso = parsedStart && !Number.isNaN(parsedStart.getTime()) ? parsedStart.toISOString() : null
      const res: UpdatePublishingResult = await window.electronAPI.db.updateChannelPublishing({
        channelId: editingChannelId,
        default_description: editDescription || null,
        default_tags: editTags || null,
        made_for_kids: editMadeForKids,
        default_category_id: editCategoryId,
        default_language: editLanguage,
        publish_mode: editPublishMode,
        schedule_start_at: startIso,
        schedule_videos_per_day: editVideosPerDay,
        schedule_window_start_hour: editWindowStartHour,
        schedule_window_end_hour: editWindowEndHour,
        schedule_randomize_minutes: editRandomizeMinutes,
        schedule_timezone: editTimezone,
        source_folder_path: editSourceFolder,
        upload_cooldown_seconds: editUploadCooldownSeconds,
        ads_profile_id: editAdsProfileId.trim() || null
      })
      if (!res.ok) {
        setRowActionMsg(`Ошибка сохранения настроек публикации: ${res.error}`)
        return
      }
      setEditorOpen(false)
      setEditingChannelId(null)
      setRowActionMsg('Параметры публикации сохранены')
      await reload()
    } finally {
      setBusyRow(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="border border-industrial-border bg-industrial-panel p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-industrial-text">Каналы</div>
          <button
            type="button"
            onClick={() => setShowCreateForm((v) => !v)}
            className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-bg px-3 py-2 text-xs text-industrial-text hover:border-industrial-muted"
          >
            {showCreateForm ? (
              'Скрыть форму'
            ) : (
              <>
                <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
                Добавить канал
              </>
            )}
          </button>
        </div>
        {rowActionMsg ? <p className="mt-2 text-xs text-industrial-muted">{rowActionMsg}</p> : null}
        {showCreateForm ? (
          <form className="mt-3 grid max-w-xl gap-2" onSubmit={onSubmit}>
            <label className="grid gap-1 text-xs text-industrial-muted">
              Название канала
              <input
                required
                className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                value={title}
                onChange={(ev) => setTitle(ev.target.value)}
                placeholder="Например: Канал A"
              />
            </label>

            <label className="grid gap-1 text-xs text-industrial-muted">
              OAuth-профиль (Google Cloud / Desktop client)
              <select
                className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                value={oauthProfileId === '' ? '' : String(oauthProfileId)}
                onChange={(ev) => {
                  const v = ev.target.value
                  setOauthProfileId(v === '' ? '' : Number(v))
                }}
              >
                <option value="">Не выбран — можно задать позже</option>
                {oauthProfiles.map((o) => (
                  <option key={o.id} value={o.id}>
                    #{o.id} {o.label} · каналов: {o.channel_count}/10 · {(o.google_client_id || '').slice(0, 12)}
                    {(o.google_client_id || '').length > 12 ? '…' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1 text-xs text-industrial-muted">
              Прокси (SOCKS5) для этого канала
              <select
                className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                value={proxyId === '' ? '' : String(proxyId)}
                onChange={(ev) => {
                  const v = ev.target.value
                  setProxyId(v === '' ? '' : Number(v))
                }}
              >
                <option value="">Без прокси (прямое соединение)</option>
                {proxies.map((p) => (
                  <option key={p.id} value={p.id}>
                    #{p.id} {p.name ? `${p.name} · ` : ''}
                    {p.host}:{p.port}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid gap-1 text-xs text-industrial-muted">
              <span>Папка с видео (опционально)</span>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void pickFolder()}
                  className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text hover:border-industrial-muted"
                >
                  <FolderOpen className="h-4 w-4" strokeWidth={1.5} />
                  Выбрать папку…
                </button>
                <span className="font-mono text-[11px] text-industrial-dim">{folder ?? 'не выбрана'}</span>
              </div>
            </div>

            <label className="grid gap-1 text-xs text-industrial-muted">
              ADS Profile ID (опционально, для авто-открытия OAuth)
              <input
                className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
                value={adsProfileId}
                onChange={(ev) => setAdsProfileId(ev.target.value)}
                placeholder="например: h1yynkm"
              />
              <span className="text-[10px] font-normal text-industrial-dim">
                Имя профиля в колонке «ADS» подтягивается из ADS Local API после создания (URL и ключ в настройках).
              </span>
            </label>

            {error ? <div className="text-xs text-red-400">{error}</div> : null}
            <div>
              <button
                type="submit"
                className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-raised px-3 py-2 text-sm text-industrial-text hover:bg-industrial-panel"
              >
                <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
                Добавить канал
              </button>
            </div>
          </form>
        ) : null}

        {manualFlow ? (
          <div className="mt-3 border border-industrial-border bg-industrial-bg p-3 text-xs">
            <div className="text-industrial-text">Ручная привязка YouTube (канал #{manualFlow.channelId})</div>
            <p className="mt-1 text-industrial-dim">
              1) Вставь ссылку в браузер, где уже авторизован Google-аккаунт канала (открой новую вкладку и вставь из
              буфера).
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    try {
                      await navigator.clipboard.writeText(manualFlow.authUrl)
                      setManualAuthUrlCopied(true)
                      setTimeout(() => setManualAuthUrlCopied(false), 2000)
                    } catch {
                      setRowActionMsg('Не удалось скопировать ссылку в буфер обмена')
                    }
                  })()
                }}
                className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-raised px-3 py-2 text-xs text-industrial-text hover:bg-industrial-panel"
              >
                {manualAuthUrlCopied ? (
                  <Check className="h-4 w-4 text-emerald-400" strokeWidth={2} aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" strokeWidth={2} aria-hidden />
                )}
                {manualAuthUrlCopied ? 'Скопировано' : 'Скопировать ссылку'}
              </button>
            </div>
            <p className="mt-2 text-industrial-dim">
              2) После согласия Google скопируй адрес из адресной строки (URL с `code` и `state`) и вставь сюда:
            </p>
            <textarea
              rows={3}
              className="mt-2 w-full border border-industrial-border bg-industrial-panel px-2 py-2 font-mono text-[11px] text-industrial-text"
              value={manualCallbackUrl}
              onChange={(ev) => setManualCallbackUrl(ev.target.value)}
              placeholder="http://127.0.0.1:53682/oauth2callback?code=...&state=..."
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void finishManualConnect()}
                disabled={busyRow !== null || !manualCallbackUrl.trim()}
                className="border border-industrial-border bg-industrial-raised px-2 py-1 text-xs text-industrial-text disabled:opacity-40"
              >
                Завершить привязку
              </button>
              <button
                type="button"
                onClick={() => {
                  setManualFlow(null)
                  setManualCallbackUrl('')
                  setManualAuthUrlCopied(false)
                }}
                className="border border-industrial-border bg-industrial-panel px-2 py-1 text-xs text-industrial-text"
              >
                Отмена
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto border border-industrial-border bg-industrial-panel">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-industrial-raised text-industrial-muted">
            <tr>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">
                <button
                  type="button"
                  onClick={() => toggleSort('ads')}
                  className="inline-flex items-center gap-1 text-left hover:text-industrial-text"
                  title="Сортировать по ADS"
                >
                  ADS
                  {sortField === 'ads' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                </button>
              </th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Название</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">OAuth-профиль</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Прокси</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Папка</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">
                <button
                  type="button"
                  onClick={() => toggleSort('lastVideoDate')}
                  className="inline-flex items-center gap-1 text-left hover:text-industrial-text"
                  title="Сортировать по дате последнего видео"
                >
                  Дата последн. видео
                  {sortField === 'lastVideoDate' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                </button>
              </th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Действия</th>
            </tr>
          </thead>
          <tbody className="text-industrial-text">
            {channels.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-industrial-dim" colSpan={7}>
                  Каналов пока нет — заполните форму выше.
                </td>
              </tr>
            ) : (
              sortedChannels.map((ch) => {
                const px =
                  ch.proxy_id != null ? proxies.find((p) => p.id === ch.proxy_id) ?? null : null
                return (
                  <tr
                    key={ch.id}
                    className={[
                      'border-b border-industrial-border',
                      ch.has_live_stream === 1 ? 'bg-emerald-950/15 ring-1 ring-inset ring-emerald-600/70' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <td
                      className="max-w-[220px] truncate px-2 py-2 text-industrial-text"
                      title={
                        ch.ads_profile_id?.trim()
                          ? `${ch.ads_profile_name?.trim() ? `${ch.ads_profile_name.trim()} · ` : ''}ADS profile ID: ${ch.ads_profile_id.trim()}`
                          : undefined
                      }
                    >
                      {ch.ads_profile_id?.trim() ? ch.ads_profile_name?.trim() || '—' : '—'}
                    </td>
                    <td className="px-2 py-2">
                      <span className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          disabled={!ch.youtube_channel_id?.trim()}
                          onClick={() => {
                            void (async () => {
                              const ytChannelId = ch.youtube_channel_id?.trim()
                              if (!ytChannelId) {
                                setRowActionMsg('У канала пока нет YouTube ID — сначала подключите YouTube.')
                                return
                              }
                              const url = `https://www.youtube.com/channel/${encodeURIComponent(ytChannelId)}`
                              const r = await window.electronAPI.openExternalUrl(url)
                              if (!r.ok) setRowActionMsg(r.error)
                            })()
                          }}
                          className="inline-flex items-center justify-center rounded border border-industrial-border bg-industrial-bg p-1 text-industrial-muted hover:border-industrial-muted hover:text-industrial-text disabled:cursor-not-allowed disabled:opacity-40"
                          title={
                            ch.youtube_channel_id?.trim()
                              ? 'Перейти на канал'
                              : 'Нельзя открыть: канал ещё не привязан к YouTube'
                          }
                        >
                          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                        </button>
                        <span>{ch.channel_title ?? '—'}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-industrial-dim">
                      {ch.oauth_profile_label ?? (ch.oauth_profile_id != null ? `#${ch.oauth_profile_id}` : '—')}
                    </td>
                    <td className="px-2 py-2 font-mono text-industrial-muted">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {px ? (
                          <>
                            <ProxyStatusGlyph lastCheckStatus={px.last_check_status} />
                            <span>
                              {px.host}:{px.port}
                            </span>
                            <button
                              type="button"
                              disabled={busyRow !== null || checkingProxyForChannelId === ch.id}
                              title="Проверить прокси"
                              onClick={() => void recheckChannelProxy(ch, px)}
                              className="inline-flex shrink-0 items-center justify-center rounded border border-industrial-border bg-industrial-bg p-1 text-industrial-muted hover:border-industrial-muted hover:text-industrial-text disabled:opacity-40"
                            >
                              {checkingProxyForChannelId === ch.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />
                              ) : (
                                <ArrowLeftRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                              )}
                            </button>
                          </>
                        ) : ch.proxy_id == null ? (
                          <span>—</span>
                        ) : (
                          <span>#{ch.proxy_id}</span>
                        )}
                        <button
                          type="button"
                          disabled={busyRow === ch.id || !(ch.ads_profile_id && ch.ads_profile_id.trim())}
                          onClick={() => void syncProxyFromAds(ch.id)}
                          className="inline-flex shrink-0 items-center justify-center rounded border border-industrial-border bg-industrial-bg p-1 text-sky-300 hover:border-industrial-muted disabled:opacity-40"
                          title="Подтянуть proxy из ADS profile в базу и привязать к каналу"
                        >
                          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-industrial-dim">{ch.source_folder_path ?? '—'}</td>
                    <td
                      className="px-2 py-2 text-industrial-muted"
                      title="Учитываются последняя публикация и отложенные слоты в очереди. Иконка — запас по календарным дням в часовом поясе расписания канала."
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <QueueBufferGlyph tier={queueBufferTier(ch.last_queue_activity_at, ch.schedule_timezone)} />
                        {formatDateTime(ch.last_queue_activity_at ?? null)}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          disabled={busyRow === ch.id || !(ch.ads_profile_id && ch.ads_profile_id.trim())}
                          onClick={() => void beginManualConnectInAds(ch.id)}
                          className="inline-flex items-center border border-industrial-border bg-industrial-bg px-2 py-1 text-[11px] text-emerald-300 hover:border-industrial-muted disabled:opacity-40"
                          title="Открыть OAuth сразу в ADS"
                        >
                          <BadgeCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          disabled={busyRow === ch.id}
                          onClick={() => openEditor(ch)}
                          className="inline-flex items-center border border-industrial-border bg-industrial-bg px-2 py-1 text-[11px] text-industrial-text hover:border-industrial-muted disabled:opacity-40"
                          title="Редактировать параметры публикации"
                        >
                          <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          disabled={busyRow === ch.id}
                          onClick={() => void beginManualConnect(ch.id)}
                          className="inline-flex items-center border border-industrial-border bg-industrial-bg px-2 py-1 text-[11px] text-industrial-text hover:border-industrial-muted disabled:opacity-40"
                          title={ch.youtube_channel_id ? 'Переподключить YouTube (ссылка)' : 'Подключить YouTube (ссылка)'}
                        >
                          <Link2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          disabled={busyRow === ch.id}
                          onClick={() => void uploadTest(ch.id)}
                          className="inline-flex items-center border border-industrial-border bg-industrial-bg px-2 py-1 text-[11px] text-industrial-text hover:border-industrial-muted disabled:opacity-40"
                          title="Загрузить видео"
                        >
                          <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          disabled={busyRow === ch.id}
                          onClick={() => void removeChannel(ch.id)}
                          className="inline-flex items-center border border-industrial-border bg-industrial-bg px-2 py-1 text-[11px] text-red-300 hover:border-red-400 disabled:opacity-40"
                          title="Удалить канал"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {editorOpen ? (
        <div className="fixed inset-0 z-40 overflow-y-auto bg-black/70">
          <div className="flex min-h-full items-start justify-center px-4 py-6 sm:items-center sm:py-8">
            <div
              className="flex min-h-0 w-full max-w-2xl max-h-[min(90dvh,calc(100dvh-3rem))] flex-col overflow-hidden border border-industrial-border bg-industrial-panel shadow-lg"
              role="dialog"
              aria-modal="true"
              aria-labelledby="channel-editor-title"
            >
              <div className="shrink-0 border-b border-industrial-border px-4 py-3">
                <div id="channel-editor-title" className="text-sm font-medium text-industrial-text">
                  Параметры публикации канала #{editingChannelId}
                </div>
                <p className="mt-1 text-xs text-industrial-dim">
                  Название видео не вводится вручную: берется из имени файла. Здесь задаются папка с исходниками, описание,
                  категория, язык и расписание.
                </p>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
                <div className="grid gap-2">
                  <div className="grid gap-1 text-xs text-industrial-muted">
                <span>Папка с видео для авто-загрузки</span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void pickEditFolder()}
                    className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text hover:border-industrial-muted"
                  >
                    <FolderOpen className="h-4 w-4" strokeWidth={1.5} />
                    Выбрать папку…
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditSourceFolder(null)}
                    className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-dim hover:border-industrial-muted hover:text-industrial-text"
                  >
                    Сбросить
                  </button>
                  <span className="font-mono text-[11px] text-industrial-dim">{editSourceFolder ?? 'не выбрана'}</span>
                </div>
                  </div>

                  <label className="grid gap-1 text-xs text-industrial-muted">
                    ADS Profile ID (для кнопки OAuth в ADS)
                    <input
                      value={editAdsProfileId}
                      onChange={(ev) => setEditAdsProfileId(ev.target.value)}
                      placeholder="например: h1yynkm"
                      className="max-w-[18rem] border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
                    />
                  </label>
                  {editingChannel?.ads_profile_name?.trim() ? (
                    <p className="text-[11px] text-industrial-dim">
                      Имя в ADS (из API): {editingChannel.ads_profile_name.trim()}
                    </p>
                  ) : null}

                  <label className="grid gap-1 text-xs text-industrial-muted">
                    Пауза между загрузками (секунды)
                    <input
                      type="number"
                      min={0}
                      max={3600}
                      value={editUploadCooldownSeconds}
                      onChange={(ev) => setEditUploadCooldownSeconds(Number(ev.target.value))}
                      onWheel={(ev) => (ev.currentTarget as HTMLInputElement).blur()}
                      className="max-w-[12rem] border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
                    />
                  </label>

                  <div className="grid gap-2 border border-industrial-border bg-industrial-bg p-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-industrial-muted">
                      <span>Описание видео (по умолчанию)</span>
                      <button
                        type="button"
                        onClick={() => setEditDescriptionMode('manual')}
                        className={`border px-2 py-1 ${editDescriptionMode === 'manual' ? 'border-industrial-muted bg-industrial-raised text-industrial-text' : 'border-industrial-border bg-industrial-panel text-industrial-dim'}`}
                      >
                        Вставить вручную
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditDescriptionMode('generate')}
                        className={`border px-2 py-1 ${editDescriptionMode === 'generate' ? 'border-industrial-muted bg-industrial-raised text-industrial-text' : 'border-industrial-border bg-industrial-panel text-industrial-dim'}`}
                      >
                        Сгенерировать
                      </button>
                    </div>
                    {editDescriptionMode === 'generate' ? (
                      <>
                        <label className="grid gap-1 text-xs text-industrial-muted">
                          Промт: о чем видео
                          <textarea
                            rows={3}
                            value={editDescriptionPrompt}
                            onChange={(ev) => setEditDescriptionPrompt(ev.target.value)}
                            placeholder="Например: астрологический разбор ретроградного Меркурия на май 2026, простыми словами"
                            className="w-full border border-industrial-border bg-industrial-panel px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                          />
                        </label>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={editAiBusy !== null}
                            onClick={() => void generateMeta('description')}
                            className="inline-flex items-center gap-1 border border-industrial-border bg-industrial-raised px-2 py-1 text-xs text-industrial-text disabled:opacity-40"
                          >
                            {editAiBusy === 'description' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                            {editDescription ? 'Перегенерировать' : 'Сгенерировать'}
                          </button>
                          <span className="text-[11px] text-industrial-dim">Короткое описание + 3 хештега в конце</span>
                        </div>
                      </>
                    ) : null}
                    <textarea
                      rows={4}
                      value={editDescription}
                      onChange={(ev) => setEditDescription(ev.target.value)}
                      className="w-full border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                    />
                  </div>

                  <div className="grid gap-2 border border-industrial-border bg-industrial-bg p-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-industrial-muted">
                      <span>Теги (через запятую)</span>
                      <button
                        type="button"
                        onClick={() => setEditTagsMode('manual')}
                        className={`border px-2 py-1 ${editTagsMode === 'manual' ? 'border-industrial-muted bg-industrial-raised text-industrial-text' : 'border-industrial-border bg-industrial-panel text-industrial-dim'}`}
                      >
                        Вставить вручную
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditTagsMode('generate')}
                        className={`border px-2 py-1 ${editTagsMode === 'generate' ? 'border-industrial-muted bg-industrial-raised text-industrial-text' : 'border-industrial-border bg-industrial-panel text-industrial-dim'}`}
                      >
                        Сгенерировать
                      </button>
                    </div>
                    {editTagsMode === 'generate' ? (
                      <>
                        <label className="grid gap-1 text-xs text-industrial-muted">
                          Промт: о чем видео
                          <input
                            value={editTagsPrompt}
                            onChange={(ev) => setEditTagsPrompt(ev.target.value)}
                            placeholder="Например: натальная карта, совместимость, гороскоп, таро, психология"
                            className="border border-industrial-border bg-industrial-panel px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                          />
                        </label>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={editAiBusy !== null}
                            onClick={() => void generateMeta('tags')}
                            className="inline-flex items-center gap-1 border border-industrial-border bg-industrial-raised px-2 py-1 text-xs text-industrial-text disabled:opacity-40"
                          >
                            {editAiBusy === 'tags' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                            {editTags ? 'Перегенерировать' : 'Сгенерировать'}
                          </button>
                          <span className="text-[11px] text-industrial-dim">Формат: тег1, тег2... до 450 символов</span>
                        </div>
                      </>
                    ) : null}
                    <input
                      value={editTags}
                      onChange={(ev) => setEditTags(ev.target.value)}
                      placeholder="астрология, натальная карта, таро"
                      className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                    />
                    <div className="text-[11px] text-industrial-dim">
                      Длина строки тегов: {editTags.length}/450
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <label className="grid gap-1 text-xs text-industrial-muted">
                  Категория
                  <select
                    value={editCategoryId}
                    onChange={(ev) => setEditCategoryId(ev.target.value)}
                    className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                  >
                    {CATEGORY_OPTIONS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.id} · {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-industrial-muted">
                  Язык видео и описания
                  <input
                    value={editLanguage}
                    onChange={(ev) => setEditLanguage(ev.target.value)}
                    placeholder="ru"
                    className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                  />
                </label>
                  </div>

                  <div className="mt-1 border border-industrial-border bg-industrial-bg p-2">
                <div className="text-xs text-industrial-muted">Доступ и публикация</div>
                <div className="mt-2 flex gap-4 text-xs text-industrial-text">
                  <label className="inline-flex items-center gap-2">
                    <input type="radio" checked={editMadeForKids === 1} onChange={() => setEditMadeForKids(1)} />
                    Видео для детей
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input type="radio" checked={editMadeForKids === 0} onChange={() => setEditMadeForKids(0)} />
                    Видео НЕ для детей
                  </label>
                </div>
                <div className="mt-2 flex gap-4 text-xs text-industrial-text">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="publishMode"
                      checked={editPublishMode === 'manual'}
                      onChange={() => setEditPublishMode('manual')}
                    />
                    Ручной режим (без отложки)
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="publishMode"
                      checked={editPublishMode === 'scheduled'}
                      onChange={() => setEditPublishMode('scheduled')}
                    />
                    Отложенная публикация
                  </label>
                </div>

                {editPublishMode === 'scheduled' ? (
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <label className="grid gap-1 text-xs text-industrial-muted">
                      Старт расписания (дата и время)
                      <input
                        type="datetime-local"
                        value={editScheduleStartAt}
                        onChange={(ev) => setEditScheduleStartAt(ev.target.value)}
                        className="border border-industrial-border bg-industrial-panel px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-industrial-muted">
                      Часовой пояс
                      <select
                        value={editTimezone}
                        title={editTimezone}
                        onChange={(ev) => setEditTimezone(ev.target.value)}
                        className="max-w-full border border-industrial-border bg-industrial-panel px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                      >
                        {editTimezone.trim() && !isListedScheduleTimezone(editTimezone) ? (
                          <option value={editTimezone}>
                            {timezoneSelectLabel(editTimezone)} — сохранённое значение
                          </option>
                        ) : null}
                        {scheduleTimezoneOptions.map((tz) => (
                          <option key={tz} value={tz}>
                            {timezoneSelectLabel(tz)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs text-industrial-muted">
                      Сколько видео в день
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={editVideosPerDay}
                        onChange={(ev) => setEditVideosPerDay(Number(ev.target.value))}
                        onWheel={(ev) => (ev.currentTarget as HTMLInputElement).blur()}
                        className="border border-industrial-border bg-industrial-panel px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-industrial-muted">
                      Рандомизация (минут ±)
                      <input
                        type="number"
                        min={0}
                        max={240}
                        value={editRandomizeMinutes}
                        onChange={(ev) => setEditRandomizeMinutes(Number(ev.target.value))}
                        onWheel={(ev) => (ev.currentTarget as HTMLInputElement).blur()}
                        className="border border-industrial-border bg-industrial-panel px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-industrial-muted">
                      Окно публикации: с (час)
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={editWindowStartHour}
                        onChange={(ev) => setEditWindowStartHour(Number(ev.target.value))}
                        onWheel={(ev) => (ev.currentTarget as HTMLInputElement).blur()}
                        className="border border-industrial-border bg-industrial-panel px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-industrial-muted">
                      Окно публикации: до (час)
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={editWindowEndHour}
                        onChange={(ev) => setEditWindowEndHour(Number(ev.target.value))}
                        onWheel={(ev) => (ev.currentTarget as HTMLInputElement).blur()}
                        className="border border-industrial-border bg-industrial-panel px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                      />
                    </label>
                    <div className="border border-industrial-border bg-industrial-panel p-2 md:col-span-2">
                      <div className="text-xs text-industrial-muted">
                        Превью следующих 10 времён публикации ({editTimezone || 'локальное время'})
                      </div>
                      {previewTimes.length === 0 ? (
                        <div className="mt-1 text-xs text-industrial-dim">Нет будущих слотов по текущим настройкам.</div>
                      ) : (
                        <div className="mt-1 grid gap-1 text-xs text-industrial-text">
                          {previewTimes.map((t, i) => (
                            <div key={i}>
                              Видео {i + 1}:{' '}
                              {t.toLocaleString('ru-RU', {
                                year: 'numeric',
                                month: 'short',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit'
                              })}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
                  </div>

                  <div className="mt-1 border border-industrial-border bg-industrial-bg p-2 text-xs text-industrial-dim">
                <div>
                  Последняя загруженная публикация:{' '}
                  <span className="text-industrial-text">{formatDateTime(editingChannel?.last_uploaded_at ?? null)}</span>
                  {editingChannel?.last_uploaded_video_id ? (
                    <>
                      {' '}
                      ·{' '}
                      <a
                        href={`https://youtu.be/${editingChannel.last_uploaded_video_id}`}
                        className="text-industrial-text underline"
                      >
                        открыть видео
                      </a>
                    </>
                  ) : null}
                </div>
                <div className="mt-1">
                  Ближайшая отложенная публикация:{' '}
                  <span className="text-industrial-text">
                    {formatDateTime(editingChannel?.next_scheduled_publish_at ?? null)}
                  </span>
                </div>
                  </div>
                </div>
              </div>

              <div className="shrink-0 border-t border-industrial-border bg-industrial-panel px-4 py-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void saveEditor()}
                    disabled={busyRow !== null}
                    className="border border-industrial-border bg-industrial-raised px-3 py-2 text-sm text-industrial-text hover:border-industrial-muted disabled:opacity-40"
                  >
                    Сохранить
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditorOpen(false)
                      setEditingChannelId(null)
                    }}
                    className="border border-industrial-border bg-industrial-bg px-3 py-2 text-sm text-industrial-text hover:border-industrial-muted"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
