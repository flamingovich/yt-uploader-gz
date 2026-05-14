import {
  AlertCircle,
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeftRight,
  Baby,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  Clapperboard,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Film,
  FolderOpen,
  Globe,
  Hand,
  Hash,
  History,
  KeyRound,
  Languages,
  Layers,
  LayoutGrid,
  Link2,
  ListVideo,
  Loader2,
  Lock,
  Network,
  Pencil,
  Plus,
  Save,
  Settings2,
  Sparkles,
  Tags,
  Timer,
  Trash2,
  Tv,
  Upload,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  isListedScheduleTimezone,
  sortedScheduleTimezones,
  timezoneSelectLabel
} from '../lib/timezones'
import { collectFuturePublishCandidates } from '@services/schedule/publishSchedule'
import { formatTimeHmFromMins, parseTimeHmToMins } from '../lib/scheduleWindowHm'
import { ProxyStatusGlyph } from '../lib/proxyCheckDisplay'
import adsLogo from '../../../ads_logo.jpg'

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
type FolderVideoCountCell = { status: 'loading' } | { status: 'ok'; count: number } | { status: 'error' }
type ChannelsSortDir = 'asc' | 'desc'

const CATEGORY_OPTIONS = [
  { id: '22', label: 'People & Blogs' },
  { id: '24', label: 'Entertainment' },
  { id: '27', label: 'Education' },
  { id: '28', label: 'Science & Technology' },
  { id: '10', label: 'Music' },
  { id: '20', label: 'Gaming' }
]

const thIconClass = 'h-3.5 w-3.5 shrink-0 text-sky-500/75'

function AdsProxyPullGlyph(): JSX.Element {
  return (
    <span
      className="relative inline-flex h-[22px] w-[22px] items-center justify-center rounded-md border border-emerald-500/35 bg-gradient-to-br from-emerald-950/55 to-industrial-bg shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
      aria-hidden
    >
      <img
        src={adsLogo}
        alt=""
        className="h-3 w-3 rounded-[3px] object-cover shadow-sm ring-1 ring-white/12"
      />
      <span className="absolute -bottom-px -right-px flex h-3 w-3 items-center justify-center rounded-full bg-industrial-raised ring-1 ring-sky-400/45 shadow-sm">
        <ArrowDownToLine className="h-1.5 w-1.5 text-sky-400" strokeWidth={3} aria-hidden />
      </span>
    </span>
  )
}

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

function formatLastVideoDate(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const rawDate = d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
  const datePart = rawDate.replace(/\s*г\.?\s*$/i, '').trim()
  const timePart = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return `${datePart} г. в ${timePart}`
}

function hasPourCooldownPassed(value: string | null): boolean {
  if (!value) return true
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return true
  const DAY_MS = 24 * 60 * 60 * 1000
  return Date.now() - d.getTime() >= DAY_MS
}

/** Группы слотов превью по календарному дню в часовом поясе расписания. */
type PublishPreviewDayGroup = {
  dayKey: string
  dayTitle: string
  slots: { slotIndex: number; at: Date; timeLabel: string }[]
}

function buildPublishPreviewGroups(dates: Date[], scheduleTimezone: string): PublishPreviewDayGroup[] {
  if (dates.length === 0) return []
  const tz = scheduleTimezone.trim() || 'UTC'

  const dayKeyOf = (d: Date): string => {
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

  const dayTitleOf = (d: Date): string => {
    try {
      const s = new Intl.DateTimeFormat('ru-RU', {
        timeZone: tz,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      }).format(d)
      const trimmed = s.replace(/\s*г\.?\s*$/i, '').trim()
      return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed
    } catch {
      const s = d.toLocaleDateString('ru-RU', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })
      const trimmed = s.replace(/\s*г\.?\s*$/i, '').trim()
      return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed
    }
  }

  const timeOf = (d: Date): string => {
    try {
      return new Intl.DateTimeFormat('ru-RU', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit'
      }).format(d)
    } catch {
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    }
  }

  const groups: PublishPreviewDayGroup[] = []
  for (let i = 0; i < dates.length; i++) {
    const at = dates[i]
    const key = dayKeyOf(at)
    const prev = groups[groups.length - 1]
    if (!prev || prev.dayKey !== key) {
      groups.push({ dayKey: key, dayTitle: dayTitleOf(at), slots: [] })
    }
    groups[groups.length - 1].slots.push({
      slotIndex: i + 1,
      at,
      timeLabel: timeOf(at)
    })
  }
  return groups
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
  const [uploadJobs, setUploadJobs] = useState<Record<number, { cancelRequested: boolean; startedAt: string }>>({})
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
  const [editWindowStartHm, setEditWindowStartHm] = useState('9:00')
  const [editWindowEndHm, setEditWindowEndHm] = useState('23:59')
  const [editRandomizeMinutes, setEditRandomizeMinutes] = useState(45)
  const [editTimezone, setEditTimezone] = useState('Europe/Moscow')
  const [editSourceFolder, setEditSourceFolder] = useState<string | null>(null)
  const [editFolderVideoCount, setEditFolderVideoCount] = useState<FolderVideoCountCell | null>(null)
  const [editUploadCooldownSeconds, setEditUploadCooldownSeconds] = useState(20)
  const [editAdsProfileId, setEditAdsProfileId] = useState('')
  const [checkingProxyForChannelId, setCheckingProxyForChannelId] = useState<number | null>(null)
  const [bulkAdsOauthBusy, setBulkAdsOauthBusy] = useState(false)
  const [folderVideoCounts, setFolderVideoCounts] = useState<Record<number, FolderVideoCountCell>>({})
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
    const w0 = parseTimeHmToMins(editWindowStartHm, 9 * 60)
    let w1 = parseTimeHmToMins(editWindowEndHm, 23 * 60 + 59)
    if (w1 <= w0) w1 = Math.min(1439, w0 + 59)
    return collectFuturePublishCandidates({
      baseIso,
      videosPerDay: editVideosPerDay,
      windowStartMins: w0,
      windowEndMins: w1,
      randomizeMinutes: editRandomizeMinutes,
      minFuture,
      needCount: 10,
      mode: 'preview'
    })
  }, [
    editPublishMode,
    editScheduleStartAt,
    editVideosPerDay,
    editWindowStartHm,
    editWindowEndHm,
    editRandomizeMinutes
  ])

  const publishPreviewGroups = useMemo(
    () => buildPublishPreviewGroups(previewTimes, editTimezone),
    [previewTimes, editTimezone]
  )

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

  const reloadUploadJobs = useCallback(async () => {
    const res = await window.electronAPI.db.listActiveUploadJobs()
    if (!res.ok) return
    const next: Record<number, { cancelRequested: boolean; startedAt: string }> = {}
    for (const job of res.data) {
      next[job.channelId] = { cancelRequested: Boolean(job.cancel_requested), startedAt: job.startedAt }
    }
    setUploadJobs(next)
  }, [])

  useEffect(() => {
    void Promise.all([reload(), reloadUploadJobs()])
  }, [reload, reloadUploadJobs])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onDataChanged(() => {
      void Promise.all([reload(), reloadUploadJobs()])
    })
    return unsubscribe
  }, [reload, reloadUploadJobs])

  useEffect(() => {
    const targets = channels
      .map((ch) => {
        const p = ch.source_folder_path?.trim()
        return p ? { id: ch.id, path: p } : null
      })
      .filter((x): x is { id: number; path: string } => x !== null)
    if (targets.length === 0) {
      setFolderVideoCounts({})
      return
    }
    setFolderVideoCounts(() => {
      const next: Record<number, FolderVideoCountCell> = {}
      for (const { id } of targets) next[id] = { status: 'loading' }
      return next
    })
    let cancelled = false
    void Promise.all(
      targets.map(async ({ id, path }) => {
        const r = await window.electronAPI.fs.countVideosInFolder({ folderPath: path })
        if (cancelled) return
        setFolderVideoCounts((prev) => ({
          ...prev,
          [id]: r.ok ? { status: 'ok', count: r.count } : { status: 'error' }
        }))
      })
    )
    return () => {
      cancelled = true
    }
  }, [channels])

  useEffect(() => {
    if (!editorOpen) {
      setEditFolderVideoCount(null)
      return
    }
    const path = editSourceFolder?.trim()
    if (!path) {
      setEditFolderVideoCount(null)
      return
    }
    setEditFolderVideoCount({ status: 'loading' })
    let cancelled = false
    void (async () => {
      const r = await window.electronAPI.fs.countVideosInFolder({ folderPath: path })
      if (cancelled) return
      setEditFolderVideoCount(r.ok ? { status: 'ok', count: r.count } : { status: 'error' })
    })()
    return () => {
      cancelled = true
    }
  }, [editorOpen, editSourceFolder])

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
        const normalizedError = /fetch failed/i.test(res.error)
          ? 'Ошибка запуска OAuth: Не запущен ADS Power'
          : `Ошибка запуска OAuth в ADS: ${res.error}`
        setRowActionMsg(normalizedError)
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
      setRowActionMsg(`Канал подключен и проверен автоматически: ${waitRes.data.channel_title}`)
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
    if (uploadJobs[channelId]) return
    setRowActionMsg(null)
    setUploadJobs((prev) => ({
      ...prev,
      [channelId]: { cancelRequested: false, startedAt: new Date().toISOString() }
    }))
    try {
      const res: UploadResult = await window.electronAPI.db.uploadTestVideo({ channelId })
      if (!res.ok) {
        setRowActionMsg(`Ошибка загрузки: ${res.error}`)
        return
      }
      setRowActionMsg(
        `Загрузка завершена: успешно ${res.data.uploaded}, ошибок ${res.data.failed}, сегодня ${res.data.daily_used}/${res.data.daily_limit}`
      )
      await Promise.all([reload(), reloadUploadJobs()])
    } finally {
      await reloadUploadJobs()
    }
  }

  async function cancelUpload(channelId: number): Promise<void> {
    setRowActionMsg(null)
    const res = await window.electronAPI.db.cancelUpload({ channelId })
    if (!res.ok) {
      setRowActionMsg(`Не удалось отменить загрузку: ${res.error}`)
      await reloadUploadJobs()
      return
    }
    setUploadJobs((prev) => {
      const row = prev[channelId]
      if (!row) return prev
      return { ...prev, [channelId]: { ...row, cancelRequested: true } }
    })
    setRowActionMsg('Остановка запрошена: текущий файл завершится, после чего пакет остановится.')
  }

  async function checkOAuth(channelId: number): Promise<void> {
    if (busyRow !== null) return
    setRowActionMsg(null)
    setBusyRow(channelId)
    try {
      const res = await window.electronAPI.db.oauthCheck({ channelId })
      if (!res.ok) setRowActionMsg(res.error)
      await reload()
    } finally {
      setBusyRow(null)
    }
  }

  async function reconnectOAuthChannelsInAdsBulk(): Promise<void> {
    if (bulkAdsOauthBusy || busyRow !== null) return
    setBulkAdsOauthBusy(true)
    setRowActionMsg(null)
    try {
      const seenAds = new Set<string>()
      const queue: ChannelRow[] = []
      for (const ch of channels) {
        const ads = ch.ads_profile_id?.trim()
        if (!ads) continue
        if (ch.oauth_status === 'ok') continue
        if (seenAds.has(ads)) continue
        seenAds.add(ads)
        queue.push(ch)
      }
      if (queue.length === 0) {
        setRowActionMsg(
          'Нет каналов с ADS profile id, где OAuth не в статусе «ок». Укажите ADS id в параметрах канала и сохраните, либо подключите OAuth.'
        )
        return
      }
      setRowActionMsg(`Очередь OAuth в ADS: ${queue.length} профилей. Запускаю по одному…`)
      let done = 0
      let failed = 0
      for (let i = 0; i < queue.length; i += 1) {
        const ch = queue[i]!
        const adsLabel = (ch.ads_profile_name ?? '').trim() || (ch.ads_profile_id ?? '').trim() || `#${ch.id}`
        setBusyRow(ch.id)
        setRowActionMsg(`[${i + 1}/${queue.length}] Открываю OAuth в ADS: ${adsLabel}`)
        const beginRes: BeginManualInAdsResult = await window.electronAPI.db.oauthBeginManualInAds({ channelId: ch.id })
        if (!beginRes.ok) {
          failed += 1
          const msg = /fetch failed/i.test(beginRes.error)
            ? 'Не запущен ADS Power'
            : `Не удалось открыть OAuth в ADS для ${adsLabel}: ${beginRes.error}`
          setRowActionMsg(`[${i + 1}/${queue.length}] ${msg}`)
          continue
        }

        setRowActionMsg(`[${i + 1}/${queue.length}] Жду завершение OAuth: ${adsLabel}`)
        let oauthConfirmed = false
        let lastWaitError = ''
        let lastCheckError = ''
        // Иногда ADS/браузер закрывают вкладку так, что callback зависает в ожидании.
        // Делаем короткие wait-попытки и fallback на прямой oauthCheck.
        for (let attempt = 0; attempt < 8 && !oauthConfirmed; attempt += 1) {
          const waitRes: WaitManualResult = await window.electronAPI.db.oauthWaitManual({
            flowId: beginRes.data.flowId,
            timeoutMs: 30000
          })
          if (waitRes.ok) {
            oauthConfirmed = true
            break
          }
          lastWaitError = waitRes.error
          const checkRes = await window.electronAPI.db.oauthCheck({ channelId: ch.id })
          if (checkRes.ok) {
            oauthConfirmed = true
            break
          }
          lastCheckError = checkRes.error
          setRowActionMsg(
            `[${i + 1}/${queue.length}] Еще жду OAuth для ${adsLabel} (попытка ${attempt + 1}/8)…`
          )
        }
        if (!oauthConfirmed) {
          failed += 1
          const reason = lastCheckError || lastWaitError || 'таймаут подтверждения OAuth'
          setRowActionMsg(
            `[${i + 1}/${queue.length}] Не удалось подтвердить OAuth для ${adsLabel}: ${reason}. Перехожу к следующему профилю.`
          )
          continue
        }

        const checkRes = await window.electronAPI.db.oauthCheck({ channelId: ch.id })
        if (!checkRes.ok) {
          failed += 1
          setRowActionMsg(
            `[${i + 1}/${queue.length}] OAuth подтвержден, но финальный OAuth-check не прошел для ${adsLabel}: ${checkRes.error}`
          )
          continue
        }

        done += 1
        setRowActionMsg(
          `[${i + 1}/${queue.length}] OAuth подтвержден: ${checkRes.data.channel_title}. Открываю следующий профиль…`
        )
        await reload()
      }
      setBusyRow(null)
      setRowActionMsg(`Переподключение завершено: успешно ${done}, с ошибками ${failed}.`)
    } finally {
      setBulkAdsOauthBusy(false)
      setBusyRow(null)
      await reload()
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
    const queueLastActivity =
      ch.last_queue_activity_at && ch.last_queue_activity_at.trim() !== '' ? ch.last_queue_activity_at : null
    const queueNext =
      ch.next_scheduled_publish_at && ch.next_scheduled_publish_at.trim() !== ''
        ? ch.next_scheduled_publish_at
        : null
    const savedStart =
      ch.schedule_start_at && ch.schedule_start_at.trim() !== '' ? ch.schedule_start_at : null
    // Приоритет: последняя активность очереди (последнее видео/слот), чтобы новые слоты не пересекались.
    const startDefault = queueLastActivity ?? queueNext ?? savedStart
    setEditScheduleStartAt(toDateTimeLocalValue(startDefault))
    setEditVideosPerDay(ch.schedule_videos_per_day || 4)
    const startMins =
      typeof ch.schedule_window_start_mins === 'number' && Number.isFinite(ch.schedule_window_start_mins)
        ? ch.schedule_window_start_mins
        : (ch.schedule_window_start_hour ?? 9) * 60
    const endMins =
      typeof ch.schedule_window_end_mins === 'number' && Number.isFinite(ch.schedule_window_end_mins)
        ? ch.schedule_window_end_mins
        : (ch.schedule_window_end_hour ?? 23) * 60 + 59
    setEditWindowStartHm(formatTimeHmFromMins(startMins))
    setEditWindowEndHm(formatTimeHmFromMins(endMins))
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
      const w0 = parseTimeHmToMins(editWindowStartHm, 9 * 60)
      const w1 = parseTimeHmToMins(editWindowEndHm, 23 * 60 + 59)
      if (w1 <= w0) {
        setRowActionMsg('Окно публикации: время «до» должно быть позже «с» (например 9:00 → 18:30).')
        return
      }
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
        schedule_window_start_mins: w0,
        schedule_window_end_mins: w1,
        schedule_window_start_hour: Math.floor(w0 / 60),
        schedule_window_end_hour: Math.floor(w1 / 60),
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
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={bulkAdsOauthBusy || busyRow !== null}
            onClick={() => void reconnectOAuthChannelsInAdsBulk()}
            className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-bg px-3 py-2 text-xs text-industrial-text hover:border-industrial-muted disabled:opacity-50"
            title="Открыть привязку OAuth в ADS по очереди: один профиль за раз, с ожиданием callback и автопроверкой OAuth перед следующим"
          >
            {bulkAdsOauthBusy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />
                OAuth в ADS…
              </>
            ) : (
              'Переподключить OAuth (ADS)'
            )}
          </button>
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
        <table className="w-full border-collapse text-left text-[11px] leading-tight">
          <thead className="sticky top-0 bg-industrial-raised text-[10px] text-industrial-muted">
            <tr>
              <th className="border-b border-industrial-border px-2 py-1.5 font-medium">
                <button
                  type="button"
                  onClick={() => toggleSort('ads')}
                  className="inline-flex items-center gap-1.5 text-left hover:text-industrial-text"
                  title="Сортировать по ADS"
                >
                  <Layers className={thIconClass} strokeWidth={2} aria-hidden />
                  <span>
                    ADS
                    {sortField === 'ads' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                  </span>
                </button>
              </th>
              <th className="border-b border-industrial-border px-2 py-1.5 font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <Tv className={thIconClass} strokeWidth={2} aria-hidden />
                  Название
                </span>
              </th>
              <th className="border-b border-industrial-border px-2 py-1.5 font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <KeyRound className={thIconClass} strokeWidth={2} aria-hidden />
                  OAuth-профиль
                </span>
              </th>
              <th className="border-b border-industrial-border px-2 py-1.5 font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <Network className={thIconClass} strokeWidth={2} aria-hidden />
                  Прокси
                </span>
              </th>
              <th className="border-b border-industrial-border px-2 py-1.5 font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <FolderOpen className={thIconClass} strokeWidth={2} aria-hidden />
                  Папка
                </span>
              </th>
              <th className="border-b border-industrial-border px-2 py-1.5 font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <History className={thIconClass} strokeWidth={2} aria-hidden />
                  Дата последнего пролива
                </span>
              </th>
              <th className="border-b border-industrial-border px-2 py-1.5 font-medium">
                <button
                  type="button"
                  onClick={() => toggleSort('lastVideoDate')}
                  className="inline-flex items-center gap-1.5 text-left hover:text-industrial-text"
                  title="Сортировать по дате последнего видео"
                >
                  <CalendarClock className={thIconClass} strokeWidth={2} aria-hidden />
                  <span>
                    Пролит до
                    {sortField === 'lastVideoDate' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                  </span>
                </button>
              </th>
              <th className="border-b border-industrial-border px-2 py-1.5 font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <ListVideo className={thIconClass} strokeWidth={2} aria-hidden />
                  Действия
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="text-industrial-text">
            {channels.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-industrial-dim" colSpan={8}>
                  Каналов пока нет — заполните форму выше.
                </td>
              </tr>
            ) : (
              sortedChannels.map((ch) => {
                const activeUpload = uploadJobs[ch.id] ?? null
                const px =
                  ch.proxy_id != null ? proxies.find((p) => p.id === ch.proxy_id) ?? null : null
                return (
                  <tr
                    key={ch.id}
                    className="border-b border-industrial-border"
                  >
                    <td
                      className="max-w-[220px] truncate px-2 py-1.5 text-industrial-text"
                      title={
                        ch.ads_profile_id?.trim()
                          ? `${ch.ads_profile_name?.trim() ? `${ch.ads_profile_name.trim()} · ` : ''}ADS profile ID: ${ch.ads_profile_id.trim()}`
                          : undefined
                      }
                    >
                      {ch.ads_profile_id?.trim() ? ch.ads_profile_name?.trim() || '—' : '—'}
                    </td>
                    <td className="px-2 py-1.5">
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
                    <td className="px-2 py-1.5 text-industrial-dim">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {ch.oauth_status === 'ok' ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" strokeWidth={1.8} aria-hidden />
                        ) : ch.oauth_status === 'invalid' ? (
                          <AlertTriangle className="h-3.5 w-3.5 text-red-400" strokeWidth={1.8} aria-hidden />
                        ) : null}
                        <span>{ch.oauth_profile_label ?? (ch.oauth_profile_id != null ? `#${ch.oauth_profile_id}` : '—')}</span>
                        <button
                          type="button"
                          disabled={busyRow === ch.id || !(ch.ads_profile_id && ch.ads_profile_id.trim())}
                          onClick={() => void beginManualConnectInAds(ch.id)}
                          className="inline-flex shrink-0 items-center justify-center rounded border border-industrial-border bg-industrial-bg p-1 text-emerald-300 hover:border-industrial-muted disabled:opacity-40"
                          title="Открыть OAuth сразу в ADS"
                        >
                          <img src={adsLogo} alt="ADS" className="h-3.5 w-3.5 rounded-[2px] object-cover" />
                        </button>
                        <button
                          type="button"
                          disabled={busyRow === ch.id}
                          onClick={() => void checkOAuth(ch.id)}
                          className="inline-flex shrink-0 items-center justify-center rounded border border-industrial-border bg-industrial-bg p-1 text-industrial-text hover:border-industrial-muted disabled:opacity-40"
                          title="Полная проверка OAuth (YouTube API)"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                        </button>
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-industrial-muted">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {px ? (
                          <>
                            <ProxyStatusGlyph lastCheckStatus={px.last_check_status} />
                            <span>#{px.id}</span>
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
                          className="inline-flex shrink-0 items-center justify-center rounded border border-industrial-border bg-industrial-bg p-0.5 text-sky-300 hover:border-emerald-500/40 hover:shadow-[0_0_0_1px_rgba(52,211,153,0.15)] disabled:opacity-40"
                          title="Подтянуть proxy из ADS profile в базу и привязать к каналу"
                        >
                          <AdsProxyPullGlyph />
                        </button>
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      {(() => {
                        const folderPath = ch.source_folder_path?.trim()
                        if (!folderPath) {
                          return <span className="text-industrial-dim">—</span>
                        }
                        const fc = folderVideoCounts[ch.id]
                        const countPart =
                          fc?.status === 'ok'
                            ? `${fc.count} видео`
                            : fc?.status === 'error'
                              ? '—'
                              : '…'
                        return (
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                void (async () => {
                                  const r = await window.electronAPI.fs.openFolder({ folderPath })
                                  if (!r.ok) setRowActionMsg(r.error)
                                })()
                              }}
                              className="border border-industrial-border bg-industrial-bg px-2 py-1 text-[11px] text-industrial-text hover:border-industrial-muted"
                              title={folderPath}
                            >
                              Перейти в папку
                            </button>
                            <span
                              className="text-industrial-muted"
                              title={
                                fc?.status === 'error'
                                  ? 'Не удалось посчитать файлы в папке (нет доступа или путь недействителен)'
                                  : 'Файлы .mp4, .mov, .mkv, .avi, .webm во всех подпапках, кроме каталогов с именем uploaded'
                              }
                            >
                              {countPart}
                            </span>
                          </span>
                        )
                      })()}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-industrial-muted">
                      <span className="inline-flex items-center gap-1.5">
                        {hasPourCooldownPassed(ch.last_uploaded_at ?? null) ? (
                          <CheckCircle2
                            className="h-3.5 w-3.5 shrink-0 text-emerald-400"
                            strokeWidth={1.8}
                            aria-hidden
                          />
                        ) : (
                          <Clock className="h-3.5 w-3.5 shrink-0 text-amber-400" strokeWidth={1.8} aria-hidden />
                        )}
                        {formatLastVideoDate(ch.last_uploaded_at ?? null)}
                      </span>
                    </td>
                    <td
                      className="px-2 py-1.5 text-industrial-muted"
                      title="Учитываются последняя публикация и отложенные слоты в очереди. Иконка — запас по календарным дням в часовом поясе расписания канала."
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <QueueBufferGlyph tier={queueBufferTier(ch.last_queue_activity_at, ch.schedule_timezone)} />
                        {formatLastVideoDate(ch.last_queue_activity_at ?? null)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex flex-nowrap items-center gap-1">
                        <button
                          type="button"
                          disabled={activeUpload?.cancelRequested === true}
                          onClick={() => {
                            if (activeUpload) {
                              void cancelUpload(ch.id)
                              return
                            }
                            void uploadTest(ch.id)
                          }}
                          className={`inline-flex shrink-0 items-center gap-1 border px-2 py-1 text-[11px] disabled:opacity-40 ${
                            activeUpload
                              ? 'border-red-500/60 bg-red-600/15 text-red-300 hover:border-red-400 hover:bg-red-600/25'
                              : 'border-emerald-500/60 bg-emerald-600/20 text-emerald-300 hover:border-emerald-400 hover:bg-emerald-600/30'
                          }`}
                          title={activeUpload ? 'Остановить текущий пакет загрузки' : 'Загрузить видео'}
                        >
                          {activeUpload ? (
                            <X className="h-3.5 w-3.5" strokeWidth={1.8} />
                          ) : (
                            <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
                          )}
                          <span>
                            {activeUpload
                              ? activeUpload.cancelRequested
                                ? 'Останавливаем…'
                                : 'Отменить загрузку'
                              : 'Загрузить видео'}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={busyRow === ch.id}
                          onClick={() => openEditor(ch)}
                          className="inline-flex shrink-0 items-center border border-industrial-border bg-industrial-bg px-2 py-1 text-[11px] text-industrial-text hover:border-industrial-muted disabled:opacity-40"
                          title="Редактировать параметры публикации"
                        >
                          <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                        </button>
                        <button
                          type="button"
                          disabled={busyRow === ch.id}
                          onClick={() => void removeChannel(ch.id)}
                          className="inline-flex shrink-0 items-center border border-industrial-border bg-industrial-bg px-2 py-1 text-[11px] text-red-300 hover:border-red-400 disabled:opacity-40"
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
                <div id="channel-editor-title" className="inline-flex items-center gap-2 text-sm font-medium text-industrial-text">
                  <Settings2 className="h-4 w-4 shrink-0 text-sky-500/80" strokeWidth={2} aria-hidden />
                  Параметры публикации канала #{editingChannelId}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
                <div className="grid gap-2">
                  <div className="relative overflow-hidden rounded border border-emerald-500/25 bg-gradient-to-br from-emerald-950/25 to-industrial-bg p-3">
                    <div className="flex gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-emerald-500/30 bg-industrial-bg shadow-inner">
                        <FolderOpen className="h-5 w-5 text-emerald-400/90" strokeWidth={1.75} aria-hidden />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="inline-flex items-center gap-1.5 text-xs font-medium text-industrial-text">
                          <Clapperboard className="h-3.5 w-3.5 text-emerald-400/80" strokeWidth={2} aria-hidden />
                          Папка с видео для авто-загрузки
                        </div>
                        {editSourceFolder?.trim() ? (
                          <>
                            <div
                              className="mt-1.5 break-all rounded border border-industrial-border/80 bg-industrial-panel px-2 py-1.5 font-mono text-[11px] leading-snug text-industrial-muted"
                              title={editSourceFolder}
                            >
                              {editSourceFolder}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {editFolderVideoCount?.status === 'loading' ? (
                                <span className="inline-flex items-center gap-1.5 rounded border border-industrial-border bg-industrial-bg px-2 py-0.5 text-[11px] text-industrial-dim">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" strokeWidth={2} aria-hidden />
                                  Сканирование…
                                </span>
                              ) : editFolderVideoCount?.status === 'ok' ? (
                                <span className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-950/40 px-2 py-0.5 text-[11px] font-medium text-emerald-200">
                                  <Film className="h-3.5 w-3.5 shrink-0 opacity-90" strokeWidth={2} aria-hidden />
                                  {editFolderVideoCount.count} видео
                                  <span className="font-normal text-emerald-200/65">· без uploaded</span>
                                </span>
                              ) : editFolderVideoCount?.status === 'error' ? (
                                <span className="inline-flex items-center gap-1 text-[11px] text-red-400">
                                  <AlertCircle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                                  Не удалось посчитать файлы
                                </span>
                              ) : null}
                            </div>
                          </>
                        ) : (
                          <p className="mt-1.5 text-[11px] text-industrial-dim">
                            Выберите каталог с исходниками — сразу покажем, сколько в нём подходящих видео (рекурсивно,
                            каталоги <span className="font-mono text-industrial-muted">uploaded</span> не учитываются).
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void pickEditFolder()}
                        className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text hover:border-industrial-muted"
                      >
                        <FolderOpen className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                        Выбрать папку…
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditSourceFolder(null)}
                        className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-dim hover:border-industrial-muted hover:text-industrial-text"
                      >
                        <X className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                        Сбросить
                      </button>
                    </div>
                  </div>

                  <label className="grid gap-1 text-xs text-industrial-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <Hash className="h-3.5 w-3.5 shrink-0 text-sky-500/70" strokeWidth={2} aria-hidden />
                      ADS Profile ID (для кнопки OAuth в ADS)
                    </span>
                    <input
                      value={editAdsProfileId}
                      onChange={(ev) => setEditAdsProfileId(ev.target.value)}
                      placeholder="например: h1yynkm"
                      className="max-w-[18rem] border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
                    />
                  </label>

                  <label className="grid gap-1 text-xs text-industrial-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <Timer className="h-3.5 w-3.5 shrink-0 text-amber-500/70" strokeWidth={2} aria-hidden />
                      Пауза между загрузками (секунды)
                    </span>
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

                  <div
                    className={`relative grid gap-2 overflow-hidden border border-industrial-border bg-industrial-bg p-2 ${
                      editAiBusy === 'description' ? 'pb-11 ring-2 ring-sky-500/40 ring-offset-0 ring-offset-industrial-bg' : ''
                    }`}
                  >
                    {editAiBusy === 'description' ? (
                      <>
                        <div
                          className="pointer-events-none absolute left-0 right-0 top-0 z-[1] h-0.5 overflow-hidden bg-sky-950/50"
                          aria-hidden
                        >
                          <div className="h-full w-2/5 bg-gradient-to-r from-transparent via-sky-400/70 to-transparent animate-shimmer" />
                        </div>
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] flex items-center justify-center gap-2 border-t border-sky-500/25 bg-gradient-to-t from-industrial-panel via-industrial-panel/95 to-transparent py-2 text-[11px] text-sky-200/95">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />
                          <span className="animate-pulse">Генерация описания…</span>
                        </div>
                      </>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-industrial-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <FileText className="h-3.5 w-3.5 text-sky-500/70" strokeWidth={2} aria-hidden />
                        Описание видео (по умолчанию)
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditDescriptionMode('manual')}
                        className={`inline-flex items-center gap-1 border px-2 py-1 ${editDescriptionMode === 'manual' ? 'border-industrial-muted bg-industrial-raised text-industrial-text' : 'border-industrial-border bg-industrial-panel text-industrial-dim'}`}
                      >
                        <Pencil className="h-3 w-3" strokeWidth={2} aria-hidden />
                        Вручную
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditDescriptionMode('generate')}
                        className={`inline-flex items-center gap-1 border px-2 py-1 ${editDescriptionMode === 'generate' ? 'border-industrial-muted bg-industrial-raised text-industrial-text' : 'border-industrial-border bg-industrial-panel text-industrial-dim'}`}
                      >
                        <Sparkles className="h-3 w-3" strokeWidth={2} aria-hidden />
                        Сгенерировать
                      </button>
                    </div>
                    {editDescriptionMode === 'generate' ? (
                      <>
                        <label className="grid gap-1 text-xs text-industrial-muted">
                          <span className="inline-flex items-center gap-1.5">
                            <Sparkles className="h-3 w-3 text-sky-400/70" strokeWidth={2} aria-hidden />
                            Промт: о чем видео
                          </span>
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
                      className={`w-full border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted ${
                        editAiBusy === 'description' ? 'opacity-90' : ''
                      }`}
                    />
                  </div>

                  <div
                    className={`relative grid gap-2 overflow-hidden border border-industrial-border bg-industrial-bg p-2 ${
                      editAiBusy === 'tags' ? 'pb-11 ring-2 ring-violet-500/40 ring-offset-0 ring-offset-industrial-bg' : ''
                    }`}
                  >
                    {editAiBusy === 'tags' ? (
                      <>
                        <div
                          className="pointer-events-none absolute left-0 right-0 top-0 z-[1] h-0.5 overflow-hidden bg-violet-950/50"
                          aria-hidden
                        >
                          <div className="h-full w-2/5 bg-gradient-to-r from-transparent via-violet-400/70 to-transparent animate-shimmer" />
                        </div>
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] flex items-center justify-center gap-2 border-t border-violet-500/25 bg-gradient-to-t from-industrial-panel via-industrial-panel/95 to-transparent py-2 text-[11px] text-violet-200/95">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />
                          <span className="animate-pulse">Генерация тегов…</span>
                        </div>
                      </>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-industrial-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <Tags className="h-3.5 w-3.5 text-violet-400/80" strokeWidth={2} aria-hidden />
                        Теги (через запятую)
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditTagsMode('manual')}
                        className={`inline-flex items-center gap-1 border px-2 py-1 ${editTagsMode === 'manual' ? 'border-industrial-muted bg-industrial-raised text-industrial-text' : 'border-industrial-border bg-industrial-panel text-industrial-dim'}`}
                      >
                        <Pencil className="h-3 w-3" strokeWidth={2} aria-hidden />
                        Вручную
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditTagsMode('generate')}
                        className={`inline-flex items-center gap-1 border px-2 py-1 ${editTagsMode === 'generate' ? 'border-industrial-muted bg-industrial-raised text-industrial-text' : 'border-industrial-border bg-industrial-panel text-industrial-dim'}`}
                      >
                        <Sparkles className="h-3 w-3" strokeWidth={2} aria-hidden />
                        Сгенерировать
                      </button>
                    </div>
                    {editTagsMode === 'generate' ? (
                      <>
                        <label className="grid gap-1 text-xs text-industrial-muted">
                          <span className="inline-flex items-center gap-1.5">
                            <Sparkles className="h-3 w-3 text-violet-400/70" strokeWidth={2} aria-hidden />
                            Промт: о чем видео
                          </span>
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
                          <span className="text-[11px] text-industrial-dim">Формат: тег1, тег2… до 450 символов</span>
                        </div>
                      </>
                    ) : null}
                    <input
                      value={editTags}
                      onChange={(ev) => setEditTags(ev.target.value)}
                      placeholder="астрология, натальная карта, таро"
                      className={`w-full border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted ${
                        editAiBusy === 'tags' ? 'opacity-90' : ''
                      }`}
                    />
                    <div className="inline-flex items-center gap-1.5 text-[11px] text-industrial-dim">
                      <Hash className="h-3 w-3 shrink-0 opacity-70" strokeWidth={2} aria-hidden />
                      Длина строки тегов: {editTags.length}/450
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <label className="grid gap-1 text-xs text-industrial-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-amber-500/65" strokeWidth={2} aria-hidden />
                    Категория
                  </span>
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
                  <span className="inline-flex items-center gap-1.5">
                    <Languages className="h-3.5 w-3.5 shrink-0 text-sky-500/65" strokeWidth={2} aria-hidden />
                    Язык видео и описания
                  </span>
                  <input
                    value={editLanguage}
                    onChange={(ev) => setEditLanguage(ev.target.value)}
                    placeholder="ru"
                    className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                  />
                </label>
                  </div>

                  <div className="mt-1 border border-industrial-border bg-industrial-bg p-2">
                <div className="inline-flex items-center gap-1.5 text-xs font-medium text-industrial-muted">
                  <Lock className="h-3.5 w-3.5 text-amber-500/60" strokeWidth={2} aria-hidden />
                  Доступ и публикация
                </div>
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-xs text-industrial-text">
                  <label className="inline-flex items-center gap-2">
                    <input type="radio" checked={editMadeForKids === 1} onChange={() => setEditMadeForKids(1)} />
                    <Baby className="h-3.5 w-3.5 text-industrial-muted" strokeWidth={2} aria-hidden />
                    Видео для детей
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input type="radio" checked={editMadeForKids === 0} onChange={() => setEditMadeForKids(0)} />
                    <Globe className="h-3.5 w-3.5 text-industrial-muted" strokeWidth={2} aria-hidden />
                    Видео НЕ для детей
                  </label>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-xs text-industrial-text">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="publishMode"
                      checked={editPublishMode === 'manual'}
                      onChange={() => setEditPublishMode('manual')}
                    />
                    <Hand className="h-3.5 w-3.5 text-industrial-muted" strokeWidth={2} aria-hidden />
                    Ручной режим (без отложки)
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="radio"
                      name="publishMode"
                      checked={editPublishMode === 'scheduled'}
                      onChange={() => setEditPublishMode('scheduled')}
                    />
                    <Calendar className="h-3.5 w-3.5 text-industrial-muted" strokeWidth={2} aria-hidden />
                    Отложенная публикация
                  </label>
                </div>

                {editPublishMode === 'scheduled' ? (
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <label className="grid gap-1 text-xs text-industrial-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarClock className="h-3.5 w-3.5 shrink-0 text-sky-500/65" strokeWidth={2} aria-hidden />
                        Старт расписания (дата и время)
                      </span>
                      <input
                        type="datetime-local"
                        value={editScheduleStartAt}
                        onChange={(ev) => setEditScheduleStartAt(ev.target.value)}
                        className="border border-industrial-border bg-industrial-panel px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-industrial-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <Globe className="h-3.5 w-3.5 shrink-0 text-emerald-500/65" strokeWidth={2} aria-hidden />
                        Часовой пояс
                      </span>
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
                      <span className="inline-flex items-center gap-1.5">
                        <ListVideo className="h-3.5 w-3.5 shrink-0 text-amber-500/65" strokeWidth={2} aria-hidden />
                        Сколько видео в день
                      </span>
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
                      <span className="inline-flex items-center gap-1.5">
                        <Timer className="h-3.5 w-3.5 shrink-0 text-violet-400/65" strokeWidth={2} aria-hidden />
                        Рандомизация (минут ±)
                      </span>
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
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 shrink-0 text-sky-500/55" strokeWidth={2} aria-hidden />
                        Окно: с (чч:мм)
                      </span>
                      <input
                        type="text"
                        value={editWindowStartHm}
                        onChange={(ev) => setEditWindowStartHm(ev.target.value)}
                        placeholder="8:30"
                        spellCheck={false}
                        className="border border-industrial-border bg-industrial-panel px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-industrial-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 shrink-0 text-sky-500/55" strokeWidth={2} aria-hidden />
                        Окно: до (чч:мм)
                      </span>
                      <input
                        type="text"
                        value={editWindowEndHm}
                        onChange={(ev) => setEditWindowEndHm(ev.target.value)}
                        placeholder="23:00"
                        spellCheck={false}
                        className="border border-industrial-border bg-industrial-panel px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
                      />
                    </label>
                    <div className="overflow-hidden rounded-sm border border-industrial-border/80 bg-industrial-panel md:col-span-2">
                      <div className="flex items-center justify-between gap-2 border-b border-industrial-border/60 bg-industrial-raised/40 px-2 py-1">
                        <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-industrial-muted">
                          <Sparkles className="h-3 w-3 shrink-0 text-amber-500/65" strokeWidth={2} aria-hidden />
                          10 слотов
                        </span>
                        <span className="max-w-[55%] truncate font-mono text-[10px] text-industrial-dim" title={editTimezone}>
                          {editTimezone.trim() || 'локально'}
                        </span>
                      </div>
                      {previewTimes.length === 0 ? (
                        <div className="px-2 py-2 text-[10px] text-industrial-dim">Нет будущих слотов.</div>
                      ) : (
                        <div className="divide-y divide-industrial-border/35">
                          {publishPreviewGroups.map((g) => (
                            <div key={g.dayKey}>
                              <div className="flex items-center gap-1.5 bg-industrial-bg/70 px-2 py-0.5 text-[10px] font-medium text-industrial-text">
                                <Calendar className="h-3 w-3 shrink-0 text-amber-500/70" strokeWidth={2} aria-hidden />
                                <span className="capitalize leading-tight">{g.dayTitle} г.</span>
                              </div>
                              <ul className="m-0 list-none divide-y divide-industrial-border/20 p-0">
                                {g.slots.map((s) => (
                                  <li
                                    key={`${g.dayKey}-${s.slotIndex}`}
                                    className="flex items-center gap-2 px-2 py-0.5 hover:bg-industrial-raised/20"
                                  >
                                    <span
                                      className="flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded border border-amber-500/25 bg-amber-950/30 font-mono text-[9px] font-semibold tabular-nums text-amber-100/90"
                                      title={`#${s.slotIndex}`}
                                    >
                                      {s.slotIndex}
                                    </span>
                                    <span className="font-mono text-[11px] tabular-nums text-industrial-text">{s.timeLabel}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
                  </div>

                  <div className="mt-1 border border-industrial-border bg-industrial-bg p-2 text-xs text-industrial-dim">
                <div className="inline-flex flex-wrap items-center gap-1.5">
                  <History className="h-3.5 w-3.5 shrink-0 text-industrial-muted" strokeWidth={2} aria-hidden />
                  <span>
                    Последняя загруженная публикация:{' '}
                    <span className="text-industrial-text">{formatDateTime(editingChannel?.last_uploaded_at ?? null)}</span>
                  </span>
                  {editingChannel?.last_uploaded_video_id ? (
                    <>
                      <span aria-hidden>·</span>
                      <a
                        href={`https://youtu.be/${editingChannel.last_uploaded_video_id}`}
                        className="inline-flex items-center gap-1 text-industrial-text underline"
                      >
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-80" strokeWidth={2} aria-hidden />
                        открыть видео
                      </a>
                    </>
                  ) : null}
                </div>
                <div className="mt-2 inline-flex flex-wrap items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 shrink-0 text-industrial-muted" strokeWidth={2} aria-hidden />
                  <span>
                    Ближайшая отложенная публикация:{' '}
                    <span className="text-industrial-text">
                      {formatDateTime(editingChannel?.next_scheduled_publish_at ?? null)}
                    </span>
                  </span>
                </div>
                  </div>
                </div>
              </div>

              <div className="shrink-0 border-t border-industrial-border bg-industrial-panel px-4 py-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (editingChannelId) void beginManualConnect(editingChannelId)
                    }}
                    disabled={busyRow !== null || !editingChannelId}
                    className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-bg px-3 py-2 text-sm text-industrial-text hover:border-industrial-muted disabled:opacity-40"
                    title="Техническая кнопка на случай проблем с ADS: открыть OAuth ссылкой"
                  >
                    <Link2 className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                    Переподключить YouTube (ссылка)
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveEditor()}
                    disabled={busyRow !== null}
                    className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-raised px-3 py-2 text-sm text-industrial-text hover:border-industrial-muted disabled:opacity-40"
                  >
                    <Save className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                    Сохранить
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditorOpen(false)
                      setEditingChannelId(null)
                    }}
                    className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-bg px-3 py-2 text-sm text-industrial-text hover:border-industrial-muted"
                  >
                    <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
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
