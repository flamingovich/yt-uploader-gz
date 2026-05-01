import { accessSync, createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import googleapis from 'googleapis'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { ProxyRow } from '@services/db/types'

const { google } = googleapis

/** Разбор ответа Google / Gaxios для отладки в UI. */
export function formatYoutubeApiError(e: unknown): string {
  const lines: string[] = []
  if (e instanceof Error) {
    lines.push(`Error.name: ${e.name}`)
    lines.push(`Error.message: ${e.message}`)
    const any = e as { code?: string; errors?: unknown }
    if (any.code) lines.push(`Error.code: ${any.code}`)
    if (any.errors) {
      try {
        lines.push(`Error.errors:\n${JSON.stringify(any.errors, null, 2)}`)
      } catch {
        /* ignore */
      }
    }
  }
  const g = e as {
    response?: { status?: number; statusText?: string; data?: unknown }
  }
  if (g.response?.status != null) {
    lines.push(`HTTP: ${g.response.status} ${g.response.statusText ?? ''}`)
  }
  if (g.response?.data !== undefined) {
    try {
      lines.push(`Response body:\n${JSON.stringify(g.response.data, null, 2)}`)
    } catch {
      lines.push(`Response body: ${String(g.response.data)}`)
    }
  }
  if (lines.length === 0) return String(e)
  return lines.join('\n')
}

function buildSocks5Url(proxy: ProxyRow): string {
  const h = proxy.host.trim()
  const user = proxy.login?.trim()
  const pass = proxy.password ?? ''
  if (user && pass !== '') return `socks5://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${h}:${proxy.port}`
  if (user) return `socks5://${encodeURIComponent(user)}@${h}:${proxy.port}`
  return `socks5://${h}:${proxy.port}`
}

function guessThumbnailMimeType(fsPath: string): string {
  const e = fsPath.toLowerCase().slice(fsPath.lastIndexOf('.'))
  if (e === '.png') return 'image/png'
  if (e === '.webp') return 'image/webp'
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
  throw new Error('Превью: укажите файл JPG, PNG или WebP')
}

async function uploadVideoThumbnailIfPresent(
  yt: ReturnType<typeof google.youtube>,
  log: (s: string) => void,
  videoId: string,
  imagePath: string | null | undefined
): Promise<void> {
  const raw = imagePath?.trim()
  if (!raw) return
  const abs = resolve(raw)
  try {
    accessSync(abs)
  } catch {
    throw new Error(`Превью: файл не найден: ${abs}`)
  }
  const mime = guessThumbnailMimeType(abs)
  await yt.thumbnails.set({
    videoId: videoId.trim(),
    media: {
      mimeType: mime,
      body: createReadStream(abs)
    }
  })
  log(`[thumbnails.set] OK videoId=${videoId}`)
}

function applyYoutubeAuth(input: {
  clientId: string
  clientSecret: string
  refreshToken: string
  accessToken?: string | null
  proxy?: ProxyRow | null
}): ReturnType<typeof google.youtube> {
  const oauth2 = new google.auth.OAuth2(input.clientId, input.clientSecret)
  oauth2.setCredentials({
    refresh_token: input.refreshToken,
    access_token: input.accessToken ?? undefined
  })
  if (input.proxy) {
    google.options({ agent: new SocksProxyAgent(buildSocks5Url(input.proxy)) })
  } else {
    google.options({ agent: undefined })
  }
  return google.youtube({ version: 'v3', auth: oauth2 })
}

export async function fetchLiveBroadcastConcurrentViewers(input: {
  clientId: string
  clientSecret: string
  refreshToken: string
  accessToken?: string | null
  proxy?: ProxyRow | null
  broadcastId: string
}): Promise<number | null> {
  const yt = applyYoutubeAuth(input)
  const res = await yt.liveBroadcasts.list({
    id: [input.broadcastId.trim()],
    part: ['statistics']
  })
  const raw = res.data.items?.[0]?.statistics?.concurrentViewers
  if (raw === undefined || raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export async function updateLiveBroadcastMetadata(input: {
  clientId: string
  clientSecret: string
  refreshToken: string
  accessToken?: string | null
  proxy?: ProxyRow | null
  broadcastId: string
  title: string | null
  description: string | null
  tags: string[] | null
  privacyStatus: 'private' | 'public' | 'unlisted'
  categoryId: string | null
  selfDeclaredMadeForKids: boolean
  /** Локальный файл JPG/PNG/WebP — загрузка на ролик эфира (нужен video id). */
  thumbnailImagePath?: string | null
}): Promise<{ debugLog: string }> {
  const lines: string[] = []
  const log = (s: string): void => {
    lines.push(s)
  }

  const yt = applyYoutubeAuth(input)
  const bid = input.broadcastId.trim()
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean)
  const title = input.title?.trim() || 'Live'
  const description = input.description?.trim() ?? ''
  const categoryId = input.categoryId?.trim() || '22'

  log(`[apply] broadcastId=${bid}`)
  log(
    `[apply] payload: title=${JSON.stringify(title)} descLen=${description.length} tags=${tags.length} privacy=${input.privacyStatus} categoryId=${categoryId} mfk=${input.selfDeclaredMadeForKids} thumb=${input.thumbnailImagePath?.trim() ? 'yes' : 'no'}`
  )

  const bro = await yt.liveBroadcasts.list({
    id: [bid],
    part: ['contentDetails', 'snippet', 'status']
  })
  const broadcast = bro.data.items?.[0]
  log(`[liveBroadcasts.list] itemCount=${bro.data.items?.length ?? 0}`)
  if (broadcast) {
    log(
      `[liveBroadcasts.list] snippet.title=${JSON.stringify(broadcast.snippet?.title ?? null)} lifecycle=${broadcast.status?.lifeCycleStatus ?? '—'}`
    )
  }
  if (!broadcast?.id) {
    throw new Error('Трансляция не найдена по broadcast id или нет доступа OAuth')
  }

  /** У liveBroadcast в snippet нет tags/categoryId — они на связанном видео. */
  let effectiveVideoId = broadcast.contentDetails?.boundVideoId?.trim() || null
  log(
    `[bind] contentDetails.boundVideoId=${effectiveVideoId ? JSON.stringify(effectiveVideoId) : '(null)'}`
  )
  if (!effectiveVideoId) {
    log('[bind] пробуем videos.list(id=broadcastId) — иногда id эфира совпадает с id ролика предстоящего/живого эфира')
    const probe = await yt.videos.list({ id: [bid], part: ['id', 'snippet', 'status'] })
    const pv = probe.data.items?.[0]
    const lc = (pv?.snippet?.liveBroadcastContent ?? '').toLowerCase()
    if (pv?.id === bid && (lc === 'upcoming' || lc === 'live')) {
      effectiveVideoId = bid
      log(`[bind] fallback OK: liveBroadcastContent=${JSON.stringify(pv.snippet?.liveBroadcastContent)} → tags/category через videos.update`)
    } else if (pv?.id) {
      log(
        `[bind] fallback skip: videos.list вернул id=${pv.id} liveBroadcastContent=${JSON.stringify(pv.snippet?.liveBroadcastContent ?? null)}`
      )
    } else {
      log('[bind] videos.list пуст — id эфира не совпадает с id видео')
    }
  }

  if (effectiveVideoId) {
    /** Studio и список эфиров часто показывают snippet у liveBroadcast; только videos.update этого не меняет. */
    const lbUp = await yt.liveBroadcasts.update({
      part: ['snippet', 'status'],
      requestBody: {
        id: bid,
        snippet: { title, description },
        status: {
          privacyStatus: input.privacyStatus,
          selfDeclaredMadeForKids: input.selfDeclaredMadeForKids
        }
      }
    })
    log('[liveBroadcasts.update] OK (синхрон с карточкой эфира в Studio)')
    log(`[liveBroadcasts.update] after title=${JSON.stringify(lbUp.data.snippet?.title ?? null)}`)

    const vr = await yt.videos.list({
      id: [effectiveVideoId],
      part: ['snippet', 'status']
    })
    const video = vr.data.items?.[0]
    log(`[videos.list] itemCount=${vr.data.items?.length ?? 0}`)
    if (video?.snippet) {
      log(
        `[videos.list] before: title=${JSON.stringify(video.snippet.title)} categoryId=${video.snippet.categoryId ?? '—'}`
      )
    }
    if (!video?.snippet || !video.status) {
      throw new Error('Не удалось загрузить видео эфира (boundVideoId / fallback id)')
    }
    const sn = video.snippet
    const st = video.status
    const upd = await yt.videos.update({
      part: ['snippet', 'status'],
      requestBody: {
        id: effectiveVideoId,
        snippet: {
          ...sn,
          title,
          description,
          categoryId: categoryId || sn.categoryId || '22',
          tags: tags.length > 0 ? tags : sn.tags ?? []
        },
        status: {
          embeddable: st.embeddable ?? undefined,
          license: st.license ?? undefined,
          privacyStatus: input.privacyStatus,
          publicStatsViewable: st.publicStatsViewable ?? undefined,
          publishAt: st.publishAt ?? undefined,
          selfDeclaredMadeForKids: input.selfDeclaredMadeForKids,
          containsSyntheticMedia: st.containsSyntheticMedia ?? undefined
        }
      }
    })
    log('[videos.update] OK')
    log(
      `[videos.update] after: id=${upd.data.id ?? '—'} title=${JSON.stringify(upd.data.snippet?.title ?? null)} privacy=${upd.data.status?.privacyStatus ?? '—'}`
    )
    await uploadVideoThumbnailIfPresent(yt, log, effectiveVideoId, input.thumbnailImagePath)
    return { debugLog: lines.join('\n') }
  }

  if (tags.length > 0) {
    log(
      `[warn] теги (${tags.length}) не записаны: нет ни boundVideoId, ни ролика с тем же id и liveBroadcastContent=upcoming/live. В Studio привяжи ключ к эфиру / дождись создания видео эфира, затем снова «Применить».`
    )
  }
  if (categoryId && categoryId !== '22') {
    log(`[warn] categoryId=${categoryId} не записан — см. выше (нужен id видео эфира).`)
  }

  const lb = await yt.liveBroadcasts.update({
    part: ['snippet', 'status'],
    requestBody: {
      id: bid,
      snippet: {
        title,
        description
      },
      status: {
        privacyStatus: input.privacyStatus,
        selfDeclaredMadeForKids: input.selfDeclaredMadeForKids
      }
    }
  })
  log('[liveBroadcasts.update] OK (только эфир: title, description, статус — без видео для тегов/категории)')
  log(
    `[liveBroadcasts.update] after: id=${lb.data.id ?? '—'} title=${JSON.stringify(lb.data.snippet?.title ?? null)}`
  )
  if (input.thumbnailImagePath?.trim()) {
    log(
      '[warn] превью не загружено: нет id видео эфира (boundVideoId или совпадение id с upcoming/live). После привязки ключа в Studio снова «Применить».'
    )
  }
  return { debugLog: lines.join('\n') }
}

export type LiveBroadcastSummary = {
  id: string
  title: string
  lifeCycleStatus: string | null
  scheduledStartTime: string | null
}

type LiveAuthInput = {
  clientId: string
  clientSecret: string
  refreshToken: string
  accessToken?: string | null
  proxy?: ProxyRow | null
}

/** Эфиры канала по OAuth (без привязки к stream key). */
export async function listMyLiveBroadcasts(input: LiveAuthInput): Promise<LiveBroadcastSummary[]> {
  const yt = applyYoutubeAuth(input)
  const res = await yt.liveBroadcasts.list({
    part: ['id', 'snippet', 'status'],
    mine: true,
    maxResults: 50
  })
  return (res.data.items ?? [])
    .map((it) => ({
      id: it.id ?? '',
      title: it.snippet?.title ?? '',
      lifeCycleStatus: it.status?.lifeCycleStatus ?? null,
      scheduledStartTime: it.snippet?.scheduledStartTime ?? null
    }))
    .filter((x) => x.id.length > 0)
}

/** Предпочесть live / тест / готовность; завершённые и отозванные пропускать. */
export function pickPreferredBroadcastId(items: LiveBroadcastSummary[]): string | null {
  const terminal = new Set(['complete', 'revoked'])
  const ranked = items.filter((x) => !terminal.has((x.lifeCycleStatus ?? '').toLowerCase()))
  if (ranked.length === 0) return null
  const priority: Record<string, number> = {
    live: 100,
    livestarting: 95,
    testing: 85,
    teststarting: 80,
    ready: 50,
    created: 40
  }
  ranked.sort((a, b) => {
    const pa = priority[(a.lifeCycleStatus ?? '').toLowerCase()] ?? 5
    const pb = priority[(b.lifeCycleStatus ?? '').toLowerCase()] ?? 5
    if (pb !== pa) return pb - pa
    const ta = a.scheduledStartTime ? new Date(a.scheduledStartTime).getTime() : 0
    const tb = b.scheduledStartTime ? new Date(b.scheduledStartTime).getTime() : 0
    return tb - ta
  })
  return ranked[0]!.id
}

export async function suggestLiveBroadcastId(
  input: LiveAuthInput
): Promise<{ broadcastId: string; title: string; lifeCycleStatus: string | null } | null> {
  const list = await listMyLiveBroadcasts(input)
  const id = pickPreferredBroadcastId(list)
  if (!id) return null
  const hit = list.find((x) => x.id === id)
  return {
    broadcastId: id,
    title: hit?.title ?? '',
    lifeCycleStatus: hit?.lifeCycleStatus ?? null
  }
}
