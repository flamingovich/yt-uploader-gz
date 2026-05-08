import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { URL } from 'node:url'
import { promisify } from 'node:util'
import googleapis from 'googleapis'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { computeScheduledPublishAtIso } from '@services/schedule/publishSchedule'
import {
  appendActivityLog,
  countChannelsForOAuthProfile,
  countCompletedUploadsToday,
  deleteChannel,
  deleteProxy,
  deleteOAuthProfile,
  getAppSettings,
  getChannelById,
  getOAuthProfileById,
  getProxyById,
  getProxyByHostPort,
  insertChannel,
  insertOAuthProfile,
  insertUploadQueueItem,
  insertProxy,
  listActivityLogs,
  listChannels,
  listOAuthProfiles,
  listProxies,
  listUploadQueue,
  setAppSettings,
  updateUploadQueueStatus,
  updateChannelPublishingSettings,
  updateChannelOAuthData,
  updateChannelStreamPreviewLayout,
  updateChannelAdsProfileName,
  updateProxyCheckStatus,
  updateChannelProxyBinding,
  updateProxyName
} from '@services/db/queries'
import { SETTINGS_KEY_LIST, SETTINGS_KEYS } from '@services/settings/keys'
import { checkSocks5Proxy, checkSocks5ProxyUploadSpeed, checkSocks5UrlReachability } from '@services/proxy/checkSocks5'
import { MAX_CHANNELS_PER_OAUTH_PROFILE } from '@services/google/oauthProfileLimits'
import { getOAuthClientCredentialsForChannel } from '@services/google/oauthForChannel'
import { authorizeYouTubeChannel, YOUTUBE_OAUTH_SCOPES } from '@services/youtube/oauth'
import { uploadVideoToYouTube } from '@services/youtube/upload'
import {
  formatYoutubeApiError,
  suggestLiveBroadcastId,
  updateLiveBroadcastMetadata
} from '@services/youtube/liveBroadcast'
import {
  deleteStreamer,
  getStreamerById,
  insertStreamer,
  listStreamers,
  updateStreamer,
  updateStreamerProcessState
} from '@services/db/streamersQueries'
import { getStreamerRuntimeUsedProxy, getStreamerRuntimeVideoBitrateKbps, startStreamer, stopStreamer } from './streamerManager'
import {
  collectSegmentVideos,
  sanitizeStreamerFsPathForDb,
  unlinkQuiet,
  writeConcatListFileMultiOrderedPasses,
  writeConcatListFileMultiShuffledPasses,
  writeSingleSegmentConcatListMultiPasses
} from '@services/stream/streamerConcat'
import { getMediaDurationSeconds } from '@services/stream/ffprobe'
import { buildFfmpegStreamArgs } from '@services/stream/streamerFfmpeg'
import { sendTelegramNotification } from '@services/telegram/notifier'
import { openOAuthInAppWindow } from './oauthWindow'
import { openStreamPreviewWindow } from './streamPreviewWindow'
import type { ProxyRow } from '@services/db/types'
import { fetchAdsProfileSummary, startAdsProfileAndOpenUrl } from './adsPowerService'

const { google } = googleapis
const execFile = promisify(execFileCallback)

type CreateResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; debugLog?: string }
type CompactProxyInput = { host: string; port: number; login: string | null; password: string | null }
type PendingManualOAuth = {
  flowId: string
  channelId: number
  clientId: string
  clientSecret: string
  codeVerifier: string
  state: string
  redirectUri: string
  proxy?: ProxyRow
}

const pendingManualOAuth = new Map<string, PendingManualOAuth>()
const pendingManualOAuthByState = new Map<string, string>()
const pendingManualOAuthCallbacks = new Map<string, string>()
let manualOAuthCallbackServerStarted = false

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm'])

function parsePort(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
  if (!Number.isFinite(n) || n < 1 || n > 65535) return null
  return n
}

function normalizeProxyId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return null
  return n
}

function normalizeOAuthProfileId(raw: unknown): number | null {
  return normalizeProxyId(raw)
}

function buildSocks5Url(proxy: ProxyRow): string {
  const host = proxy.host.trim()
  const login = proxy.login?.trim()
  const password = proxy.password ?? ''
  if (login && password !== '') return `socks5://${encodeURIComponent(login)}:${encodeURIComponent(password)}@${host}:${proxy.port}`
  if (login) return `socks5://${encodeURIComponent(login)}@${host}:${proxy.port}`
  return `socks5://${host}:${proxy.port}`
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function getOAuthClientCredentials(channelId: number) {
  return getOAuthClientCredentialsForChannel(channelId)
}

function renderOAuthCallbackPage(message: string): string {
  const text = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<!doctype html><html><head><meta charset="utf-8"/><title>OAuth</title></head><body style="font-family:Arial,sans-serif;background:#111;color:#f4f4f5;padding:20px"><h3>${text}</h3><p>Можно закрыть эту вкладку и вернуться в приложение.</p></body></html>`
}

function ensureManualOAuthCallbackServer(): void {
  if (manualOAuthCallbackServerStarted) return
  const server = createServer((req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase()
    const rawUrl = String(req.url ?? '/')
    if (method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    let parsed: URL
    try {
      parsed = new URL(rawUrl, 'http://127.0.0.1:53682')
    } catch {
      res.statusCode = 400
      res.end('Bad Request')
      return
    }
    if (parsed.pathname !== '/oauth2callback') {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    const state = parsed.searchParams.get('state') ?? ''
    const flowId = state ? pendingManualOAuthByState.get(state) ?? '' : ''
    if (!flowId) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(renderOAuthCallbackPage('OAuth-сессия не найдена или устарела'))
      return
    }
    pendingManualOAuthCallbacks.set(flowId, parsed.toString())
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(renderOAuthCallbackPage('Готово! Авторизация получена приложением'))
  })
  server.on('error', () => {
    manualOAuthCallbackServerStarted = false
  })
  server.listen(53682, '127.0.0.1')
  manualOAuthCallbackServerStarted = true
}

async function beginManualOAuthFlow(channelId: number): Promise<{ flowId: string; authUrl: string }> {
  ensureManualOAuthCallbackServer()
  const creds = getOAuthClientCredentials(channelId)
  const state = randomBytes(24).toString('hex')
  const pkce = createPkce()
  const flowId = randomUUID()
  const redirectUri = `http://127.0.0.1:53682/oauth2callback`
  const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri)
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: YOUTUBE_OAUTH_SCOPES,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256'
  })
  pendingManualOAuth.set(flowId, {
    flowId,
    channelId,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    codeVerifier: pkce.verifier,
    state,
    redirectUri,
    proxy: creds.proxy ?? undefined
  })
  pendingManualOAuthByState.set(state, flowId)
  return { flowId, authUrl }
}

async function finishManualOAuthFlow(flowId: string, callbackUrl: string) {
  const flow = pendingManualOAuth.get(flowId)
  if (!flow) return { ok: false as const, error: 'OAuth-сессия устарела. Сгенерируйте новую ссылку.' }
  try {
    const parsed = new URL(callbackUrl)
    const state = parsed.searchParams.get('state') ?? ''
    const code = parsed.searchParams.get('code') ?? ''
    const err = parsed.searchParams.get('error')
    if (err) throw new Error(`Google вернул ошибку: ${err}`)
    if (!code) throw new Error('В callback URL нет параметра code')
    if (!state || state !== flow.state) throw new Error('State не совпадает, OAuth-сессия недействительна')

    const oauth2 = new google.auth.OAuth2(flow.clientId, flow.clientSecret, flow.redirectUri)
    if (flow.proxy) {
      google.options({ agent: new SocksProxyAgent(buildSocks5Url(flow.proxy)) })
    }
    const tokenResp = await oauth2.getToken({ code, codeVerifier: flow.codeVerifier })
    const accessToken = tokenResp.tokens.access_token ?? ''
    if (!accessToken) throw new Error('Google не вернул access_token')
    oauth2.setCredentials(tokenResp.tokens)

    const yt = google.youtube({ version: 'v3', auth: oauth2 })
    const mine = await yt.channels.list({ part: ['id', 'snippet'], mine: true })
    const ch = mine.data.items?.[0]
    if (!ch?.id) throw new Error('Не удалось получить канал YouTube по OAuth')

    updateChannelOAuthData({
      channelId: flow.channelId,
      youtube_channel_id: ch.id,
      channel_title: ch.snippet?.title ?? null,
      oauth_access_token: accessToken,
      oauth_refresh_token: tokenResp.tokens.refresh_token ?? null,
      oauth_status: 'ok',
      token_expires_at: tokenResp.tokens.expiry_date ? new Date(tokenResp.tokens.expiry_date).toISOString() : null
    })
    pendingManualOAuth.delete(flowId)
    pendingManualOAuthByState.delete(flow.state)
    pendingManualOAuthCallbacks.delete(flowId)
    logEvent({
      channel_id: flow.channelId,
      level: 'info',
      action_type: 'youtube_oauth_connected_manual',
      message: `YouTube подключен вручную: ${ch.snippet?.title ?? ch.id}`
    })
    return {
      ok: true as const,
      data: {
        channelId: flow.channelId,
        youtube_channel_id: ch.id,
        channel_title: ch.snippet?.title ?? 'YouTube Channel'
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logEvent({
      channel_id: flow.channelId,
      level: 'error',
      action_type: 'youtube_oauth_manual_failed',
      message
    })
    return { ok: false as const, error: message }
  }
}

async function syncChannelProxyFromAds(channelId: number): Promise<
  | { ok: true; data: { mode: 'imported' | 'linked_existing' | 'no_proxy'; proxy_id: number | null; summary: string } }
  | { ok: false; error: string }
> {
  const channel = getChannelById(channelId)
  if (!channel) return { ok: false, error: 'Канал не найден' }
  const adsProfileId = channel.ads_profile_id?.trim() ?? ''
  if (!adsProfileId) return { ok: false, error: 'У канала не указан ADS profile id' }
  const settings = getAppSettings()
  const apiBaseUrl = String(settings[SETTINGS_KEYS.adspower_api_base_url] ?? '').trim() || 'http://local.adspower.net:50325'
  const apiKey = String(settings[SETTINGS_KEYS.adspower_api_key] ?? '')
  const summary = await fetchAdsProfileSummary({
    baseUrl: apiBaseUrl,
    apiKey,
    profileId: adsProfileId
  })
  updateChannelAdsProfileName(channelId, summary.displayName)
  const adsProxy = summary.proxy
  if (!adsProxy) {
    updateChannelProxyBinding(channelId, null)
    return { ok: true, data: { mode: 'no_proxy', proxy_id: null, summary: 'В ADS для профиля стоит no_proxy' } }
  }
  if (adsProxy.type !== 'socks5') {
    return { ok: false, error: `Прокси в ADS имеет тип ${adsProxy.type}. В приложении поддержан только SOCKS5.` }
  }
  const existing = getProxyByHostPort(adsProxy.host, adsProxy.port)
  if (existing) {
    if (summary.displayName?.trim()) {
      updateProxyName(existing.id, `ADS - ${summary.displayName.trim()}`)
    }
    updateChannelProxyBinding(channelId, existing.id)
    return {
      ok: true,
      data: {
        mode: 'linked_existing',
        proxy_id: existing.id,
        summary: `Привязан существующий прокси #${existing.id} (${existing.host}:${existing.port})`
      }
    }
  }
  const created = insertProxy({
    name: summary.displayName?.trim() ? `ADS - ${summary.displayName.trim()}` : `ADS ${adsProfileId}`,
    host: adsProxy.host,
    port: adsProxy.port,
    login: adsProxy.login,
    password: adsProxy.password
  })
  updateChannelProxyBinding(channelId, created.id)
  return {
    ok: true,
    data: {
      mode: 'imported',
      proxy_id: created.id,
      summary: `Импортирован прокси #${created.id} (${adsProxy.host}:${adsProxy.port})`
    }
  }
}

async function hydrateMissingAdsProfileNames(): Promise<void> {
  const channels = listChannels()
  const missing = channels.filter((ch) => ch.ads_profile_id?.trim() && !ch.ads_profile_name?.trim())
  if (missing.length === 0) return
  const settings = getAppSettings()
  const apiBaseUrl = String(settings[SETTINGS_KEYS.adspower_api_base_url] ?? '').trim() || 'http://local.adspower.net:50325'
  const apiKey = String(settings[SETTINGS_KEYS.adspower_api_key] ?? '')
  for (const ch of missing) {
    const adsId = ch.ads_profile_id?.trim()
    if (!adsId) continue
    try {
      const { displayName } = await fetchAdsProfileSummary({
        baseUrl: apiBaseUrl,
        apiKey,
        profileId: adsId
      })
      if (displayName?.trim()) {
        updateChannelAdsProfileName(ch.id, displayName.trim())
      }
    } catch {
      // ignore: list should still load even if ADS API unavailable
    }
  }
}

function normalizeLegacyAdsProxyNames(): void {
  const adsNameById = new Map<string, string>()
  for (const ch of listChannels()) {
    const adsId = ch.ads_profile_id?.trim() ?? ''
    const adsName = ch.ads_profile_name?.trim() ?? ''
    if (adsId && adsName) adsNameById.set(adsId, adsName)
  }
  for (const p of listProxies()) {
    const currentName = p.name?.trim() ?? ''
    const m = /^ADS\s+([A-Za-z0-9_-]+)$/.exec(currentName)
    if (!m) continue
    const adsName = adsNameById.get(m[1] ?? '')
    if (!adsName) continue
    updateProxyName(p.id, `ADS - ${adsName}`)
  }
}

function parseCompactProxy(input: string): { ok: true; data: CompactProxyInput } | { ok: false; error: string } {
  const value = input.trim()
  if (!value) return { ok: false, error: 'Пустая строка' }
  const parts = value.split(':')
  if (parts.length !== 4) {
    return { ok: false, error: 'Ожидается формат host:port:login:password' }
  }
  const host = parts[0]?.trim() ?? ''
  const port = parsePort(parts[1])
  const login = parts[2]?.trim() ?? ''
  const password = parts[3] ?? ''
  if (!host) return { ok: false, error: 'Пустой host' }
  if (port === null) return { ok: false, error: 'Некорректный порт' }
  return {
    ok: true,
    data: {
      host,
      port,
      login: login || null,
      password: password || null
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildAiMetaPrompt(input: {
  kind: 'description' | 'tags'
  topic: string
  language: string
  category: string
  madeForKids: boolean
}): { system: string; user: string } {
  if (input.kind === 'description') {
    return {
      system:
        'Ты пишешь краткие SEO-friendly описания для YouTube. Верни только чистый текст описания без Markdown и без пояснений.',
      user: [
        `Язык: ${input.language || 'ru'}`,
        `Категория: ${input.category || 'People & Blogs'}`,
        `Для детей: ${input.madeForKids ? 'да' : 'нет'}`,
        '',
        'Задача: создай короткое описание YouTube-видео (2-4 предложения).',
        'В конце новой строкой добавь РОВНО 3 тематических хештега.',
        'Не добавляй ничего кроме итогового текста.',
        '',
        `Тема видео от пользователя: ${input.topic}`
      ].join('\n')
    }
  }
  return {
    system:
      'Ты генерируешь только список тегов для YouTube. Верни одну строку: теги через запятую, без объяснений.',
    user: [
      `Язык: ${input.language || 'ru'}`,
      `Категория: ${input.category || 'People & Blogs'}`,
      `Для детей: ${input.madeForKids ? 'да' : 'нет'}`,
      '',
      'Задача: дай релевантные SEO-теги для YouTube-видео.',
      'Формат строго: тег1, тег2, тег3...',
      'Максимум 450 символов итоговой строки.',
      'Без #, без точек с запятой, без нумерации.',
      '',
      `Тема видео от пользователя: ${input.topic}`
    ].join('\n')
  }
}

function normalizeGeneratedDescription(raw: string): string {
  const text = raw.replaceAll(/\*\*/g, '').trim()
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
  const hashtags = lines
    .join(' ')
    .split(/\s+/)
    .filter((w) => w.startsWith('#'))
    .map((w) => w.replace(/[^\p{L}\p{N}_#]/gu, ''))
  const uniqHashtags: string[] = []
  for (const h of hashtags) {
    if (!h || h === '#') continue
    if (!uniqHashtags.includes(h.toLowerCase())) uniqHashtags.push(h)
    if (uniqHashtags.length >= 3) break
  }
  while (uniqHashtags.length < 3) {
    const fallback = ['#видео', '#ютуб', '#контент'][uniqHashtags.length]!
    if (!uniqHashtags.includes(fallback)) uniqHashtags.push(fallback)
  }
  const noHash = lines
    .join('\n')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const clipped = noHash.length > 500 ? `${noHash.slice(0, 497).trimEnd()}...` : noHash
  return `${clipped}\n${uniqHashtags.slice(0, 3).join(' ')}`
}

function normalizeGeneratedTags(raw: string): string {
  const tokens = raw
    .replaceAll('\n', ',')
    .split(/[,;|]/)
    .map((x) => x.replace(/^#+/, '').trim())
    .filter(Boolean)
  const uniq: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const normalized = token.replace(/\s{2,}/g, ' ')
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(normalized)
  }
  let out = ''
  for (const tag of uniq) {
    const candidate = out ? `${out}, ${tag}` : tag
    if (candidate.length > 450) break
    out = candidate
  }
  return out
}

function stripPollinationsServiceTail(raw: string): string {
  const marker = '\n---\n'
  const idx = raw.indexOf(marker)
  if (idx >= 0) return raw.slice(0, idx).trim()
  const supportIdx = raw.toLowerCase().indexOf('support pollinations.ai')
  if (supportIdx >= 0) return raw.slice(0, supportIdx).trim()
  return raw.trim()
}

async function listVideosForUpload(rootFolder: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'uploaded') continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase()
      if (VIDEO_EXTENSIONS.has(ext)) out.push(full)
    }
  }
  await walk(rootFolder)
  return out
}

async function captureSingleFrameImage(inputPath: string, tag: string): Promise<string> {
  const ext = extname(inputPath).toLowerCase()
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') return inputPath
  const outPath = join(tmpdir(), `ytu-preview-${tag}-${randomBytes(6).toString('hex')}.png`)
  let seekSec = 1
  try {
    const dur = await getMediaDurationSeconds(inputPath)
    if (dur && Number.isFinite(dur)) {
      // Первый кадр часто черный, берём более репрезентативный.
      seekSec = Math.min(6, Math.max(0.6, dur * 0.22))
    }
  } catch {
    // keep default seek
  }
  await execFile(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      seekSec.toFixed(2),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outPath
    ],
    { windowsHide: true }
  )
  return outPath
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
    throw new Error('Не удалось подготовить ffmpeg args для рендера')
  }
  args.splice(flvIdx, args.length - flvIdx, '-t', String(durationSec), '-movflags', '+faststart', '-f', 'mp4', outputFile)
  return args
}

function normalizeFsPathForCompare(pathRaw: string): string {
  const v = String(pathRaw || '').trim()
  if (!v) return ''
  const fileUrlMatch = /^file:\/\/\/?/i
  let out = v
  if (fileUrlMatch.test(out)) {
    out = out.replace(fileUrlMatch, '')
    out = out.replace(/\//g, '\\')
    out = decodeURIComponent(out)
  }
  out = out.replace(/\//g, '\\').toLowerCase()
  return out
}

function extensionFromDataImageMime(mime: string): string {
  const m = mime.toLowerCase()
  if (m === 'image/gif') return '.gif'
  if (m === 'image/png') return '.png'
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg'
  if (m === 'image/webp') return '.webp'
  if (m === 'image/bmp') return '.bmp'
  return '.img'
}

async function materializeLayoutDataUrlSources(layoutJson: string): Promise<{ layoutJson: string; tempFiles: string[] }> {
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
    const tempPath = join(tmpdir(), `ytu-preview-src-${Date.now()}-${randomBytes(6).toString('hex')}${ext}`)
    const content = Buffer.from(b64, 'base64')
    await fsp.writeFile(tempPath, content)
    source.filePath = tempPath
    source.src = tempPath
    tempFiles.push(tempPath)
  }
  return { layoutJson: JSON.stringify(obj), tempFiles }
}

async function renderMinuteWithProgress(input: {
  args: string[]
  totalSec: number
  onProgress?: (p: { elapsedSec: number; totalSec: number; remainingSec: number; percent: number }) => void
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-progress', 'pipe:2', '-nostats', ...input.args], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const total = Math.max(1, input.totalSec)
    input.onProgress?.({ elapsedSec: 0, totalSec: total, remainingSec: total, percent: 0 })
    p.stderr?.setEncoding('utf8')
    p.stderr?.on('data', (chunk: string) => {
      const lines = chunk.split(/\r?\n/)
      for (const line of lines) {
        const outTimeMs = /^out_time_ms=(\d+)/.exec(line.trim())
        if (outTimeMs) {
          const elapsedSec = Math.max(0, Number(outTimeMs[1] || 0) / 1_000_000)
          const percent = Math.max(0, Math.min(100, (elapsedSec / total) * 100))
          input.onProgress?.({
            elapsedSec,
            totalSec: total,
            remainingSec: Math.max(0, total - elapsedSec),
            percent
          })
          continue
        }
        const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
        if (!m) continue
        const hh = Number(m[1] || 0)
        const mm = Number(m[2] || 0)
        const ss = Number(m[3] || 0)
        const elapsedSec = hh * 3600 + mm * 60 + ss
        const percent = Math.max(0, Math.min(100, (elapsedSec / total) * 100))
        input.onProgress?.({
          elapsedSec,
          totalSec: total,
          remainingSec: Math.max(0, total - elapsedSec),
          percent
        })
      }
    })
    p.once('error', reject)
    p.once('close', (code) => {
      if (code === 0) {
        input.onProgress?.({ elapsedSec: total, totalSec: total, remainingSec: 0, percent: 100 })
        resolve()
      } else {
        reject(new Error(`ffmpeg завершился с кодом ${code ?? '—'}`))
      }
    })
  })
}

async function buildPreviewRenderConcatList(payload: {
  stream_mode?: 'random' | 'ordered' | 'single'
  segments_folder_path?: string | null
  single_segment_path?: string | null
  bumper_video_path?: string | null
}): Promise<string> {
  const mode = payload?.stream_mode === 'ordered' || payload?.stream_mode === 'single' ? payload.stream_mode : 'random'
  const bumperPath = String(payload?.bumper_video_path ?? '').trim()
  const bumperNorm = normalizeFsPathForCompare(bumperPath)
  if (mode === 'single') {
    const one = String(payload?.single_segment_path ?? '').trim()
    if (!one) throw new Error('Для режима «Один кусок» выберите mp4 файл')
    return writeSingleSegmentConcatListMultiPasses({ segmentPath: one })
  }
  const dir = String(payload?.segments_folder_path ?? '').trim()
  if (!dir) throw new Error('Выберите папку с кусками')
  const segsRaw = await collectSegmentVideos(dir)
  const segs = bumperNorm ? segsRaw.filter((p) => normalizeFsPathForCompare(p) !== bumperNorm) : segsRaw
  if (segsRaw.length > 0 && segs.length < 1) {
    throw new Error('В папке осталась только заглушка, выберите рабочие куски видео')
  }
  if (segs.length < 1) throw new Error('В папке нет видеофайлов')
  return mode === 'ordered'
    ? writeConcatListFileMultiOrderedPasses({ segmentPaths: segs })
    : writeConcatListFileMultiShuffledPasses({ segmentPaths: segs })
}

function randomShuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

async function moveToUploadedFolder(filePath: string, rootFolder: string): Promise<string> {
  const uploadedDir = join(rootFolder, 'uploaded')
  await fsp.mkdir(uploadedDir, { recursive: true })
  const base = basename(filePath)
  let target = join(uploadedDir, base)
  try {
    await fsp.access(target)
    const stamp = new Date().toISOString().replaceAll(':', '-')
    const ext = extname(base)
    const name = base.slice(0, ext ? -ext.length : undefined)
    target = join(uploadedDir, `${name}-${stamp}${ext}`)
  } catch {
    // target does not exist, use as is
  }
  await fsp.rename(filePath, target)
  return target
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function formatLogForTelegram(entry: {
  channel_id?: number | null
  queue_id?: number | null
  level: 'info' | 'warn' | 'error'
  action_type: string
  message: string
  metadata?: Record<string, unknown> | null
}): string {
  if (entry.action_type === 'upload_success') {
    const idx = Number(entry.metadata?.upload_index)
    const total = Number(entry.metadata?.upload_total)
    const progress = Number.isFinite(idx) && Number.isFinite(total) && total > 0 ? ` (${idx}/${total})` : ''
    return `✅ Видео загружено${progress}`
  }
  if (entry.action_type === 'upload_batch_finished') {
    const uploaded = Number(entry.metadata?.uploaded_count)
    const n = Number.isFinite(uploaded) ? uploaded : 0
    return `✅ Пакетная загрузка завершена (${n} видео)`
  }
  if (entry.action_type === 'upload_failed') {
    return `❌ Ошибка загрузки видео`
  }
  if (entry.action_type === 'streamer_started') {
    const streamUrl = typeof entry.metadata?.stream_url === 'string' ? entry.metadata.stream_url.trim() : ''
    return streamUrl ? `▶️ Стрим начался: <a href="${escapeHtml(streamUrl)}">ссылка</a>` : '▶️ Стрим начался'
  }
  if (entry.action_type === 'streamer_stopped') {
    return '⏹️ Стрим закончился'
  }
  return ''
}

function shouldSendTelegram(entry: { action_type: string }): boolean {
  return (
    entry.action_type === 'upload_success' ||
    entry.action_type === 'upload_batch_finished' ||
    entry.action_type === 'upload_failed' ||
    entry.action_type === 'streamer_started' ||
    entry.action_type === 'streamer_stopped'
  )
}

export function registerIpcHandlers(): void {
  const emitDataChanged = (actionType: string): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('app:dataChanged', { actionType, at: Date.now() })
      }
    }
  }

  const logEvent = (entry: {
    channel_id?: number | null
    queue_id?: number | null
    level: 'info' | 'warn' | 'error'
    action_type: string
    message: string
    metadata?: Record<string, unknown> | null
  }): void => {
    appendActivityLog(entry)
    emitDataChanged(entry.action_type)
    const settings = getAppSettings()
    const botToken = settings[SETTINGS_KEYS.telegram_bot_token] ?? ''
    const chatId = settings[SETTINGS_KEYS.telegram_chat_id] ?? ''
    if (!botToken || !chatId) return
    if (!shouldSendTelegram(entry)) return
    const text = formatLogForTelegram(entry)
    if (!text.trim()) return
    void sendTelegramNotification({
      botToken,
      chatId,
      text,
      parseMode: 'HTML',
      disableWebPagePreview: false
    }).catch(() => {
      /* ignore telegram transport errors */
    })
  }

  ipcMain.handle('db:proxies:list', () => {
    normalizeLegacyAdsProxyNames()
    return listProxies()
  })
  ipcMain.handle('db:channels:list', async () => {
    await hydrateMissingAdsProfileNames()
    return listChannels()
  })
  ipcMain.handle('db:oauthProfiles:list', () => listOAuthProfiles())
  ipcMain.handle(
    'db:oauthProfiles:create',
    (
      _e,
      payload: { label: string; google_client_id: string; google_client_secret: string }
    ) => {
      const label = String(payload?.label ?? '').trim()
      const cid = String(payload?.google_client_id ?? '').trim()
      const sec = String(payload?.google_client_secret ?? '')
      if (!label) return { ok: false, error: 'Укажите название профиля (например: Cloud проект A)' } satisfies CreateResult<never>
      if (!cid) return { ok: false, error: 'Укажите Client ID' } satisfies CreateResult<never>
      if (!sec) return { ok: false, error: 'Укажите Client Secret' } satisfies CreateResult<never>
      const { id } = insertOAuthProfile({
        label,
        google_client_id: cid,
        google_client_secret: sec
      })
      logEvent({
        level: 'info',
        action_type: 'oauth_profile_created',
        message: `OAuth-профиль добавлен: ${label}`,
        metadata: { oauth_profile_id: id }
      })
      return { ok: true, data: { id } } satisfies CreateResult<{ id: number }>
    }
  )

  ipcMain.handle('db:proxies:delete', (_e, idRaw: unknown) => {
    const id = Number(idRaw)
    if (!Number.isFinite(id) || id < 1) {
      return { ok: false, error: 'Некорректный id' } satisfies CreateResult<never>
    }
    const r = deleteProxy(id)
    if (!r.ok) return { ok: false, error: r.error } satisfies CreateResult<never>
    logEvent({
      level: 'warn',
      action_type: 'proxy_deleted',
      message: `Прокси удалён: id ${id}`,
      metadata: { proxy_id: id }
    })
    return { ok: true as const, data: { id } }
  })

  ipcMain.handle('channels:connectYouTube', async (_e, payload: { channelId: number }) => {
    const channelId = Number(payload?.channelId)
    if (!Number.isFinite(channelId) || channelId < 1) {
      return { ok: false, error: 'Некорректный channelId' } as const
    }
    try {
      const creds = getOAuthClientCredentials(channelId)
      if (creds.proxy) {
        const proxyHealth = await checkSocks5Proxy({
          host: creds.proxy.host,
          port: creds.proxy.port,
          login: creds.proxy.login,
          password: creds.proxy.password,
          timeoutMs: 15000
        })
        if (!proxyHealth.ok) {
          throw new Error(`Прокси канала недоступен: ${proxyHealth.error}`)
        }
        const googleReach = await checkSocks5UrlReachability({
          host: creds.proxy.host,
          port: creds.proxy.port,
          login: creds.proxy.login,
          password: creds.proxy.password,
          url: 'https://accounts.google.com/generate_204',
          timeoutMs: 15000
        })
        if (!googleReach.ok) {
          throw new Error(`Прокси не может открыть Google OAuth: ${googleReach.error}`)
        }
      }
      const oauthResult = await authorizeYouTubeChannel({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        proxy: creds.proxy ?? null,
        openExternal: async (url) => openOAuthInAppWindow({ url, proxy: creds.proxy ?? null })
      })
      updateChannelOAuthData({
        channelId,
        youtube_channel_id: oauthResult.youtubeChannelId,
        channel_title: oauthResult.youtubeChannelTitle,
        oauth_access_token: oauthResult.accessToken,
        oauth_refresh_token: oauthResult.refreshToken ?? creds.channel?.oauth_refresh_token ?? null,
        oauth_status: 'ok',
        token_expires_at: oauthResult.expiryDateIso
      })
      logEvent({
        channel_id: channelId,
        level: 'info',
        action_type: 'youtube_oauth_connected',
        message: `YouTube подключен: ${oauthResult.youtubeChannelTitle}`
      })
      return {
        ok: true as const,
        data: {
          youtube_channel_id: oauthResult.youtubeChannelId,
          channel_title: oauthResult.youtubeChannelTitle
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logEvent({
        channel_id: channelId,
        level: 'error',
        action_type: 'youtube_oauth_failed',
        message
      })
      return { ok: false as const, error: message }
    }
  })

  ipcMain.handle('channels:oauthCheck', async (_e, payload: { channelId: number }) => {
    const channelId = Number(payload?.channelId)
    if (!Number.isFinite(channelId) || channelId < 1) {
      return { ok: false as const, error: 'Некорректный channelId' }
    }
    try {
      const creds = getOAuthClientCredentials(channelId)
      const channel = creds.channel
      if (!channel?.oauth_refresh_token?.trim()) {
        updateChannelOAuthData({ channelId, oauth_status: 'invalid' })
        return { ok: false as const, error: 'OAuth не подключен: нет refresh token' }
      }
      const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret)
      oauth2.setCredentials({
        refresh_token: channel.oauth_refresh_token,
        access_token: channel.oauth_access_token ?? undefined
      })
      if (creds.proxy) {
        google.options({ agent: new SocksProxyAgent(buildSocks5Url(creds.proxy)) })
      } else {
        google.options({ agent: undefined })
      }
      const at = await oauth2.getAccessToken()
      const accessToken = typeof at === 'string' ? at : at?.token
      if (!accessToken) {
        updateChannelOAuthData({ channelId, oauth_status: 'invalid' })
        return { ok: false as const, error: 'Не удалось получить access_token' }
      }
      const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 })
      const tokenInfo = await oauth2Api.tokeninfo({ access_token: accessToken })
      const scopeRaw = String(tokenInfo.data.scope ?? '').trim()
      const scopes = scopeRaw ? scopeRaw.split(/\s+/) : []
      const hasUploadScope =
        scopes.includes('https://www.googleapis.com/auth/youtube.upload') ||
        scopes.includes('https://www.googleapis.com/auth/youtube') ||
        scopes.includes('https://www.googleapis.com/auth/youtube.force-ssl')
      if (!hasUploadScope) {
        updateChannelOAuthData({ channelId, oauth_status: 'invalid' })
        return { ok: false as const, error: 'Недостаточно OAuth scope для YouTube upload' }
      }
      const yt = google.youtube({ version: 'v3', auth: oauth2 })
      const mine = await yt.channels.list({ part: ['id', 'snippet'], mine: true })
      const item = mine.data.items?.[0]
      if (!item?.id) {
        updateChannelOAuthData({ channelId, oauth_status: 'invalid' })
        return { ok: false as const, error: 'OAuth валиден, но YouTube не вернул канал' }
      }
      updateChannelOAuthData({ channelId, oauth_status: 'ok' })
      return {
        ok: true as const,
        data: {
          youtube_channel_id: item.id,
          channel_title: item.snippet?.title ?? item.id
        }
      }
    } catch (e) {
      updateChannelOAuthData({ channelId, oauth_status: 'invalid' })
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('channels:oauthBeginManual', async (_e, payload: { channelId: number }) => {
    const channelId = Number(payload?.channelId)
    if (!Number.isFinite(channelId) || channelId < 1) {
      return { ok: false as const, error: 'Некорректный channelId' }
    }
    try {
      return { ok: true as const, data: await beginManualOAuthFlow(channelId) }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('channels:oauthBeginManualInAds', async (_e, payload: { channelId: number }) => {
    const channelId = Number(payload?.channelId)
    if (!Number.isFinite(channelId) || channelId < 1) {
      return { ok: false as const, error: 'Некорректный channelId' }
    }
    try {
      const channel = getChannelById(channelId)
      if (!channel) return { ok: false as const, error: 'Канал не найден' }
      const adsProfileId = channel.ads_profile_id?.trim() ?? ''
      if (!adsProfileId) {
        return { ok: false as const, error: 'У канала не указан ADS profile id' }
      }
      const settings = getAppSettings()
      const apiBaseUrl = String(settings[SETTINGS_KEYS.adspower_api_base_url] ?? '').trim() || 'http://local.adspower.net:50325'
      const apiKey = String(settings[SETTINGS_KEYS.adspower_api_key] ?? '')
      const syncRes = await syncChannelProxyFromAds(channelId)
      if (syncRes.ok) {
        logEvent({
          channel_id: channelId,
          level: 'info',
          action_type: 'ads_proxy_synced',
          message: syncRes.data.summary,
          metadata: { proxy_id: syncRes.data.proxy_id, mode: syncRes.data.mode }
        })
      } else {
        logEvent({
          channel_id: channelId,
          level: 'warn',
          action_type: 'ads_proxy_sync_failed',
          message: syncRes.error
        })
      }
      const flow = await beginManualOAuthFlow(channelId)
      await startAdsProfileAndOpenUrl({
        baseUrl: apiBaseUrl,
        apiKey,
        profileId: adsProfileId,
        url: flow.authUrl
      })
      logEvent({
        channel_id: channelId,
        level: 'info',
        action_type: 'youtube_oauth_opened_ads',
        message: `OAuth открыт в ADS profile ${adsProfileId}`
      })
      return { ok: true as const, data: flow }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('channels:syncProxyFromAds', async (_e, payload: { channelId: number }) => {
    const channelId = Number(payload?.channelId)
    if (!Number.isFinite(channelId) || channelId < 1) {
      return { ok: false as const, error: 'Некорректный channelId' }
    }
    try {
      const res = await syncChannelProxyFromAds(channelId)
      if (!res.ok) {
        logEvent({
          channel_id: channelId,
          level: 'warn',
          action_type: 'ads_proxy_sync_failed',
          message: res.error
        })
        return res
      }
      logEvent({
        channel_id: channelId,
        level: 'info',
        action_type: 'ads_proxy_synced',
        message: res.data.summary,
        metadata: { proxy_id: res.data.proxy_id, mode: res.data.mode }
      })
      return res
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logEvent({
        channel_id: channelId,
        level: 'warn',
        action_type: 'ads_proxy_sync_failed',
        message
      })
      return { ok: false as const, error: message }
    }
  })

  ipcMain.handle('channels:oauthFinishManual', async (_e, payload: { flowId: string; callbackUrl: string }) => {
    const flowId = String(payload?.flowId ?? '')
    const callbackUrl = String(payload?.callbackUrl ?? '').trim()
    if (!flowId) return { ok: false as const, error: 'flowId не передан' }
    if (!callbackUrl) return { ok: false as const, error: 'Вставьте callback URL из браузера' }
    return finishManualOAuthFlow(flowId, callbackUrl)
  })

  ipcMain.handle('channels:oauthWaitManual', async (_e, payload: { flowId: string; timeoutMs?: number }) => {
    const flowId = String(payload?.flowId ?? '').trim()
    if (!flowId) return { ok: false as const, error: 'flowId не передан' }
    const timeoutMsRaw = Number(payload?.timeoutMs ?? 180000)
    const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(10_000, Math.min(900_000, timeoutMsRaw)) : 180000
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const callbackUrl = pendingManualOAuthCallbacks.get(flowId)
      if (callbackUrl) {
        pendingManualOAuthCallbacks.delete(flowId)
        return finishManualOAuthFlow(flowId, callbackUrl)
      }
      if (!pendingManualOAuth.has(flowId)) {
        return { ok: false as const, error: 'OAuth-сессия устарела. Запустите привязку заново.' }
      }
      await sleep(500)
    }
    return { ok: false as const, error: 'Таймаут ожидания OAuth callback. Можно завершить вручную через callback URL.' }
  })

  ipcMain.handle('channels:uploadTestVideo', async (_event, payload: { channelId: number }) => {
    const channelId = Number(payload?.channelId)
    if (!Number.isFinite(channelId) || channelId < 1) {
      return { ok: false, error: 'Некорректный channelId' } as const
    }
    try {
      const DAILY_LIMIT = 10
      const creds = getOAuthClientCredentials(channelId)
      const refreshToken = creds.channel?.oauth_refresh_token ?? ''
      if (!refreshToken) {
        throw new Error('Сначала нажмите "Подключить YouTube" для этого канала')
      }
      const doneToday = countCompletedUploadsToday(channelId)
      const remainingToday = Math.max(0, DAILY_LIMIT - doneToday)
      if (remainingToday <= 0) {
        return {
          ok: false as const,
          error: `Дневной лимит достигнут: ${doneToday}/${DAILY_LIMIT} загрузок на сегодня`
        }
      }
      const sourceFolder = creds.channel?.source_folder_path?.trim() ?? ''
      if (!sourceFolder) {
        return { ok: false as const, error: 'У канала не выбрана папка source_folder_path' }
      }
      const allCandidates = await listVideosForUpload(sourceFolder)
      if (allCandidates.length === 0) {
        return { ok: false as const, error: 'В исходной папке нет видео для загрузки' }
      }
      const shuffled = randomShuffle(allCandidates)
      const selected = shuffled.slice(0, remainingToday)
      if (allCandidates.length > selected.length) {
        logEvent({
          channel_id: channelId,
          level: 'warn',
          action_type: 'upload_daily_limit_trim',
          message: `Найдено ${allCandidates.length} файлов, загружаем только ${selected.length} из-за лимита ${DAILY_LIMIT}/сутки`
        })
      }

      if (creds.proxy) {
        const proxyCheck = await checkSocks5Proxy({
          host: creds.proxy.host,
          port: creds.proxy.port,
          login: creds.proxy.login,
          password: creds.proxy.password,
          timeoutMs: 12000
        })
        if (proxyCheck.ok) {
          logEvent({
            channel_id: channelId,
            level: 'info',
            action_type: 'upload_proxy_egress',
            message: `Upload через proxy ${creds.proxy.host}:${creds.proxy.port} -> egress ${proxyCheck.ip} (${proxyCheck.country}, ${proxyCheck.city})`
          })
        } else {
          logEvent({
            channel_id: channelId,
            level: 'warn',
            action_type: 'upload_proxy_check_failed',
            message: `Не удалось подтвердить egress proxy перед upload: ${proxyCheck.error}`
          })
        }
      } else {
        logEvent({
          channel_id: channelId,
          level: 'warn',
          action_type: 'upload_without_proxy',
          message: 'Upload запущен без прокси для канала'
        })
      }

      let uploadedCount = 0
      let failedCount = 0
      const videoIds: string[] = []
      let stopByDailyUploadCap = false
      const appSettings = getAppSettings()
      const chCd = Number(creds.channel?.upload_cooldown_seconds)
      const fromChannel = Number.isFinite(chCd) ? chCd : NaN
      const fallbackRaw = Number(appSettings[SETTINGS_KEYS.upload_cooldown_seconds] ?? '20')
      const cooldownSecondsRaw = Number.isFinite(fromChannel) ? fromChannel : fallbackRaw
      const cooldownSeconds = Number.isFinite(cooldownSecondsRaw) ? Math.max(0, Math.min(3600, cooldownSecondsRaw)) : 20

      for (let idx = 0; idx < selected.length; idx += 1) {
        if (stopByDailyUploadCap) break
        const filePath = selected[idx]!
        const publishAt =
          creds.channel?.publish_mode === 'scheduled'
            ? computeScheduledPublishAtIso({
                baseIso: creds.channel?.schedule_start_at ?? null,
                futureSlotIndex: idx,
                videosPerDay: creds.channel?.schedule_videos_per_day ?? 4,
                windowStartHour: creds.channel?.schedule_window_start_hour ?? 9,
                windowEndHour: creds.channel?.schedule_window_end_hour ?? 23,
                randomizeMinutes: creds.channel?.schedule_randomize_minutes ?? 45
              })
            : null
        const tags = (creds.channel?.default_tags ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        logEvent({
          channel_id: channelId,
          level: 'info',
          action_type: 'upload_started',
          message: `Загрузка начата: ${filePath}`
        })
        const q = insertUploadQueueItem({
          channel_id: channelId,
          file_path: filePath,
          original_filename: filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath,
          status: 'uploading',
          scheduled_publish_at: publishAt,
          privacy_status: 'private',
          description: creds.channel?.default_description ?? null
        })
        try {
          const uploaded = await uploadVideoToYouTube({
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            refreshToken,
            accessToken: creds.channel?.oauth_access_token ?? null,
            proxy: creds.proxy ?? null,
            filePath,
            description: creds.channel?.default_description ?? '',
            tags,
            madeForKids: Boolean(creds.channel?.made_for_kids),
            categoryId: creds.channel?.default_category_id ?? '22',
            defaultLanguage: creds.channel?.default_language ?? 'ru',
            privacyStatus: 'private',
            publishAt
          })
          updateUploadQueueStatus({
            id: q.id,
            status: 'completed',
            youtube_video_id: uploaded.videoId,
            completed_at: new Date().toISOString(),
            error_message: null
          })
          const movedTo = await moveToUploadedFolder(filePath, sourceFolder)
          uploadedCount += 1
          videoIds.push(uploaded.videoId)
          logEvent({
            channel_id: channelId,
            queue_id: q.id,
            level: 'info',
            action_type: 'upload_success',
            message: `Видео загружено: ${uploaded.videoId}`,
            metadata: { video_id: uploaded.videoId, moved_to: movedTo, upload_index: idx + 1, upload_total: selected.length }
          })
        } catch (fileError) {
          failedCount += 1
          const fileMessage = fileError instanceof Error ? fileError.message : String(fileError)
          const uploadCapReached = /exceeded the number of videos they may upload/i.test(fileMessage)
          if (/invalid authentication credentials|invalid_grant|authentication credentials/i.test(fileMessage)) {
            updateChannelOAuthData({ channelId, oauth_status: 'invalid' })
          }
          if (uploadCapReached) {
            stopByDailyUploadCap = true
          }
          updateUploadQueueStatus({
            id: q.id,
            status: 'failed',
            error_message: fileMessage,
            completed_at: null
          })
          logEvent({
            channel_id: channelId,
            queue_id: q.id,
            level: 'error',
            action_type: 'upload_failed',
            message: `Файл ${filePath}: ${fileMessage}`
          })
          if (uploadCapReached) {
            logEvent({
              channel_id: channelId,
              level: 'warn',
              action_type: 'upload_batch_stopped_limit',
              message: 'Пакет остановлен: YouTube вернул лимит по количеству загрузок'
            })
          }
        }
        if (idx < selected.length - 1 && cooldownSeconds > 0) {
          logEvent({
            channel_id: channelId,
            level: 'info',
            action_type: 'upload_cooldown_wait',
            message: `Пауза между загрузками: ${cooldownSeconds} сек`
          })
          await sleep(cooldownSeconds * 1000)
        }
      }

      const usedNow = doneToday + uploadedCount
      logEvent({
        channel_id: channelId,
        level: 'info',
        action_type: 'upload_batch_finished',
        message: `Пакет завершен: успешно ${uploadedCount}, ошибок ${failedCount}, сегодня ${usedNow}/${DAILY_LIMIT}`,
        metadata: { uploaded_count: uploadedCount, failed_count: failedCount }
      })

      return {
        ok: true as const,
        data: {
          uploaded: uploadedCount,
          failed: failedCount,
          selected: selected.length,
          daily_used: usedNow,
          daily_limit: DAILY_LIMIT,
          videoIds
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logEvent({
        channel_id: channelId,
        level: 'error',
        action_type: 'upload_failed',
        message
      })
      return { ok: false as const, error: message }
    }
  })

  ipcMain.handle('db:oauthProfiles:delete', (_e, id: unknown) => {
    const n = Number(id)
    if (!Number.isFinite(n) || n < 1) {
      return { ok: false, error: 'Некорректный id' } satisfies CreateResult<never>
    }
    const r = deleteOAuthProfile(n)
    if (!r.ok) {
      return { ok: false, error: r.error } satisfies CreateResult<never>
    }
    logEvent({
      level: 'info',
      action_type: 'oauth_profile_deleted',
      message: `OAuth-профиль удалён: id ${n}`
    })
    return { ok: true, data: { id: n } } satisfies CreateResult<{ id: number }>
  })
  ipcMain.handle('db:queue:list', (_e, limit?: number) => listUploadQueue(limit ?? 100))
  ipcMain.handle('db:logs:list', (_e, limit?: number) => listActivityLogs(limit ?? 200))

  ipcMain.handle('settings:get', () => getAppSettings())
  ipcMain.handle('settings:set', (_e, partial: Record<string, string>) => {
    const safe: Record<string, string> = {}
    for (const k of SETTINGS_KEY_LIST) {
      if (Object.prototype.hasOwnProperty.call(partial, k)) {
        const value = String(partial[k] ?? '')
        const isLegacyOAuthKey =
          k === SETTINGS_KEYS.google_oauth_client_id || k === SETTINGS_KEYS.google_oauth_client_secret
        // Safety guard: do not overwrite saved legacy OAuth keys with empty values accidentally.
        if (isLegacyOAuthKey && value.trim() === '') continue
        safe[k] = value
      }
    }
    setAppSettings(safe)
    logEvent({ level: 'info', action_type: 'settings_saved', message: 'Настройки сохранены' })
    return { ok: true as const }
  })

  ipcMain.handle(
    'ai:generateChannelMeta',
    async (
      _e,
      payload: {
        channelId?: number
        kind: 'description' | 'tags'
        topicPrompt: string
        language?: string
        category?: string
        madeForKids?: boolean
      }
    ) => {
      const kind = payload?.kind === 'tags' ? 'tags' : 'description'
      const topicPrompt = String(payload?.topicPrompt ?? '').trim()
      if (!topicPrompt) return { ok: false as const, error: 'Введите тему/промт для генерации' }
      const prompt = buildAiMetaPrompt({
        kind,
        topic: topicPrompt,
        language: String(payload?.language ?? 'ru').trim() || 'ru',
        category: String(payload?.category ?? '').trim() || 'People & Blogs',
        madeForKids: Boolean(payload?.madeForKids)
      })
      try {
        const res = await fetch(`https://text.pollinations.ai/${encodeURIComponent(prompt.user)}`, {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'text/plain,application/json;q=0.9,*/*;q=0.8'
          }
        })
        if (!res.ok) {
          const body = await res.text()
          throw new Error(`AI text endpoint HTTP ${res.status}: ${body.slice(0, 220)}`)
        }
        const raw = stripPollinationsServiceTail(await res.text())
        if (!raw) throw new Error('AI вернул пустой ответ')
        const output = kind === 'description' ? normalizeGeneratedDescription(raw) : normalizeGeneratedTags(raw)
        if (!output) throw new Error('Не удалось нормализовать ответ AI')
        logEvent({
          channel_id: Number.isFinite(Number(payload?.channelId)) ? Number(payload?.channelId) : null,
          level: 'info',
          action_type: 'ai_meta_generated',
          message: `Сгенерированы ${kind === 'description' ? 'описание' : 'теги'}`
        })
        return { ok: true as const, data: { text: output, kind } }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        logEvent({
          channel_id: Number.isFinite(Number(payload?.channelId)) ? Number(payload?.channelId) : null,
          level: 'warn',
          action_type: 'ai_meta_generate_failed',
          message
        })
        return { ok: false as const, error: message }
      }
    }
  )

  ipcMain.handle(
    'proxy:check',
    async (
      _e,
      payload: {
        host?: string
        port?: number
        login?: string | null
        password?: string | null
        persistId?: number | null
      }
    ) => {
      let host = String(payload?.host ?? '').trim()
      let port = parsePort(payload?.port)
      let login: string | null | undefined = payload?.login ?? null
      let password: string | null | undefined = payload?.password ?? null

      const persistId =
        typeof payload?.persistId === 'number' && Number.isFinite(payload.persistId) && payload.persistId > 0
          ? payload.persistId
          : null

      if (persistId) {
        const row = getProxyById(persistId)
        if (!row) {
          return { ok: false as const, error: 'Прокси не найден в базе' }
        }
        host = row.host
        port = row.port
        login = row.login
        password = row.password
      }

      if (!host) {
        return { ok: false as const, error: 'Укажите хост SOCKS5' }
      }
      if (port === null) {
        return { ok: false as const, error: 'Порт должен быть от 1 до 65535' }
      }

      const result = await checkSocks5Proxy({ host, port, login, password })
      const snapshot = JSON.stringify(result)
      if (persistId) {
        updateProxyCheckStatus(persistId, snapshot)
      }

      if (result.ok) {
        logEvent({
          level: 'info',
          action_type: 'proxy_check_ok',
          message: `Проверка SOCKS5: ${result.ip} · ${result.country}, ${result.city}`,
          metadata: { persistId, host, port }
        })
      } else {
        logEvent({
          level: 'warn',
          action_type: 'proxy_check_fail',
          message: `Проверка SOCKS5 не удалась: ${result.error}`,
          metadata: { persistId, host, port }
        })
      }

      return result
    }
  )

  ipcMain.handle(
    'proxy:speedTest',
    async (
      _e,
      payload: {
        host?: string
        port?: number
        login?: string | null
        password?: string | null
        persistId?: number | null
      }
    ) => {
      let host = String(payload?.host ?? '').trim()
      let port = parsePort(payload?.port)
      let login: string | null | undefined = payload?.login ?? null
      let password: string | null | undefined = payload?.password ?? null
      let persistedRow: ProxyRow | undefined
      const persistId =
        typeof payload?.persistId === 'number' && Number.isFinite(payload.persistId) && payload.persistId > 0
          ? payload.persistId
          : null
      if (persistId) {
        persistedRow = getProxyById(persistId)
        if (!persistedRow) return { ok: false as const, error: 'Прокси не найден в базе' }
        host = persistedRow.host
        port = persistedRow.port
        login = persistedRow.login
        password = persistedRow.password
      }
      if (!host) return { ok: false as const, error: 'Укажите хост SOCKS5' }
      if (port === null) return { ok: false as const, error: 'Порт должен быть от 1 до 65535' }

      const result = await checkSocks5ProxyUploadSpeed({ host, port, login, password, timeoutMs: 35000, durationSec: 12 })
      if (result.ok) {
        if (persistId) {
          let snapshotObj: Record<string, unknown> = {}
          try {
            const parsed = persistedRow?.last_check_status ? JSON.parse(persistedRow.last_check_status) : null
            if (parsed && typeof parsed === 'object') snapshotObj = parsed as Record<string, unknown>
          } catch {
            // keep empty snapshot object
          }
          snapshotObj.upload_mbps_avg = result.upload_mbps_avg
          snapshotObj.upload_test_sec = result.upload_test_sec
          snapshotObj.upload_test_at = new Date().toISOString()
          updateProxyCheckStatus(persistId, JSON.stringify(snapshotObj))
        }
        logEvent({
          level: 'info',
          action_type: 'proxy_speed_ok',
          message: `Upload speed: ${result.upload_mbps_avg} Mbps за ${result.upload_test_sec}с`,
          metadata: { persistId, host, port, upload_mbps_avg: result.upload_mbps_avg, upload_test_sec: result.upload_test_sec }
        })
      } else {
        logEvent({
          level: 'warn',
          action_type: 'proxy_speed_fail',
          message: `Upload speed test не удался: ${result.error}`,
          metadata: { persistId, host, port }
        })
      }
      return result
    }
  )

  ipcMain.handle(
    'db:proxies:create',
    (_e, payload: { name?: string | null; host: string; port: number; login?: string | null; password?: string | null }) => {
      const host = String(payload?.host ?? '').trim()
      const port = parsePort(payload?.port)
      if (!host) return { ok: false, error: 'Укажите хост SOCKS5' } satisfies CreateResult<never>
      if (port === null) return { ok: false, error: 'Порт должен быть от 1 до 65535' } satisfies CreateResult<never>
      try {
        const { id } = insertProxy({
          name: payload?.name ?? null,
          host,
          port,
          login: payload?.login ?? null,
          password: payload?.password ?? null
        })
        logEvent({
          level: 'info',
          action_type: 'proxy_created',
          message: `Прокси SOCKS5 добавлен: ${host}:${port}`,
          metadata: { proxy_id: id }
        })
        return { ok: true, data: { id } } satisfies CreateResult<{ id: number }>
      } catch (e) {
        const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: string }).code) : ''
        if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return { ok: false, error: 'Прокси с таким host:port уже есть', code: 'duplicate' } satisfies CreateResult<never>
        }
        throw e
      }
    }
  )

  ipcMain.handle('db:proxies:createBulk', (_e, payload: { lines: string; defaultNamePrefix?: string }) => {
    const raw = String(payload?.lines ?? '')
    const defaultNamePrefix = String(payload?.defaultNamePrefix ?? 'Proxy').trim() || 'Proxy'
    const lines = raw
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
    if (lines.length === 0) {
      return { ok: false, error: 'Вставьте хотя бы одну строку прокси' } satisfies CreateResult<never>
    }

    let created = 0
    const errors: string[] = []
    for (let i = 0; i < lines.length; i += 1) {
      const parsed = parseCompactProxy(lines[i]!)
      if (!parsed.ok) {
        errors.push(`Строка ${i + 1}: ${parsed.error}`)
        continue
      }
      try {
        const item = parsed.data
        const { id } = insertProxy({
          name: `${defaultNamePrefix} ${i + 1}`,
          host: item.host,
          port: item.port,
          login: item.login,
          password: item.password
        })
        created += 1
        logEvent({
          level: 'info',
          action_type: 'proxy_created_bulk',
          message: `Прокси SOCKS5 добавлен: ${item.host}:${item.port}`,
          metadata: { proxy_id: id }
        })
      } catch (e) {
        const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: string }).code) : ''
        if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
          errors.push(`Строка ${i + 1}: proxy ${lines[i]} уже есть`)
        } else {
          errors.push(`Строка ${i + 1}: ошибка вставки`)
        }
      }
    }

    return {
      ok: true as const,
      data: {
        total: lines.length,
        created,
        failed: lines.length - created,
        errors
      }
    }
  })

  ipcMain.handle(
    'db:channels:create',
    async (
      _e,
      payload: {
        proxy_id?: number | null
        oauth_profile_id?: number | null
        ads_profile_id?: string | null
        channel_title: string
        source_folder_path?: string | null
      }
    ) => {
      const title = String(payload?.channel_title ?? '').trim()
      const proxyId = normalizeProxyId(payload?.proxy_id)
      const oauthProfileId = normalizeOAuthProfileId(payload?.oauth_profile_id)
      if (!title) {
        return { ok: false, error: 'Укажите название канала' } satisfies CreateResult<never>
      }
      if (oauthProfileId) {
        const prof = getOAuthProfileById(oauthProfileId)
        if (!prof) {
          return { ok: false, error: 'OAuth-профиль не найден' } satisfies CreateResult<never>
        }
        const cnt = countChannelsForOAuthProfile(oauthProfileId)
        if (cnt >= MAX_CHANNELS_PER_OAUTH_PROFILE) {
          return {
            ok: false,
            error: `На один OAuth-профиль — не более ${MAX_CHANNELS_PER_OAUTH_PROFILE} каналов. Создайте новый профиль в настройках или выберите другой.`
          } satisfies CreateResult<never>
        }
      }
      const { id } = insertChannel({
        proxy_id: proxyId,
        oauth_profile_id: oauthProfileId,
        ads_profile_id: payload?.ads_profile_id ?? null,
        channel_title: title,
        source_folder_path: payload?.source_folder_path ?? null
      })
      const adsTrim = String(payload?.ads_profile_id ?? '').trim()
      if (adsTrim) {
        try {
          const settings = getAppSettings()
          const apiBaseUrl =
            String(settings[SETTINGS_KEYS.adspower_api_base_url] ?? '').trim() ||
            'http://local.adspower.net:50325'
          const apiKey = String(settings[SETTINGS_KEYS.adspower_api_key] ?? '')
          const { displayName } = await fetchAdsProfileSummary({
            baseUrl: apiBaseUrl,
            apiKey,
            profileId: adsTrim
          })
          updateChannelAdsProfileName(id, displayName)
        } catch {
          /* имя из ADS не обязательно для создания канала */
        }
      }
      logEvent({
        level: 'info',
        action_type: 'channel_created',
        message: `Канал добавлен: ${title}`,
        metadata: {
          channel_id: id,
          proxy_id: proxyId,
          oauth_profile_id: oauthProfileId,
          ads_profile_id: payload?.ads_profile_id ?? null
        }
      })
      return { ok: true, data: { id } } satisfies CreateResult<{ id: number }>
    }
  )

  ipcMain.handle('db:channels:delete', (_e, channelIdRaw: unknown) => {
    const channelId = Number(channelIdRaw)
    if (!Number.isFinite(channelId) || channelId < 1) {
      return { ok: false, error: 'Некорректный channelId' } satisfies CreateResult<never>
    }
    const channel = getChannelById(channelId)
    if (!channel) {
      return { ok: false, error: 'Канал не найден' } satisfies CreateResult<never>
    }
    deleteChannel(channelId)
    logEvent({
      channel_id: channelId,
      level: 'warn',
      action_type: 'channel_deleted',
      message: `Канал удален: ${channel.channel_title ?? `#${channelId}`}`
    })
    return { ok: true as const, data: { channelId } }
  })

  ipcMain.handle(
    'db:channels:updatePublishing',
    async (
      _e,
      payload: {
        channelId: number
        default_description?: string | null
        default_tags?: string | null
        made_for_kids?: number
        default_category_id?: string
        default_language?: string
        publish_mode?: 'manual' | 'scheduled'
        schedule_start_at?: string | null
        schedule_videos_per_day?: number
        schedule_window_start_hour?: number
        schedule_window_end_hour?: number
        schedule_randomize_minutes?: number
        schedule_timezone?: string
        source_folder_path?: string | null
        upload_cooldown_seconds?: number
        ads_profile_id?: string | null
      }
    ) => {
      const channelId = Number(payload?.channelId)
      if (!Number.isFinite(channelId) || channelId < 1) {
        return { ok: false, error: 'Некорректный channelId' } satisfies CreateResult<never>
      }
      const existing = getChannelById(channelId)
      if (!existing) {
        return { ok: false, error: 'Канал не найден' } satisfies CreateResult<never>
      }
      const payloadRecord = payload as Record<string, unknown>
      const sourceFolderPath = Object.prototype.hasOwnProperty.call(payloadRecord, 'source_folder_path')
        ? (payloadRecord.source_folder_path == null
            ? null
            : String(payloadRecord.source_folder_path).trim() || null)
        : existing.source_folder_path ?? null
      const mode = payload?.publish_mode === 'scheduled' ? 'scheduled' : 'manual'
      const perDay = Math.max(1, Math.min(24, Number(payload?.schedule_videos_per_day ?? 4)))
      const startHour = Math.max(0, Math.min(23, Number(payload?.schedule_window_start_hour ?? 9)))
      const endHour = Math.max(0, Math.min(23, Number(payload?.schedule_window_end_hour ?? 23)))
      const randomMins = Math.max(0, Math.min(240, Number(payload?.schedule_randomize_minutes ?? 45)))
      const category = String(payload?.default_category_id ?? '22').trim() || '22'
      const language = String(payload?.default_language ?? 'ru').trim() || 'ru'
      const timezone = String(payload?.schedule_timezone ?? 'Europe/Moscow').trim() || 'Europe/Moscow'
      const cdRaw = Number(payload?.upload_cooldown_seconds)
      const uploadCooldownSeconds = Number.isFinite(cdRaw)
        ? Math.max(0, Math.min(3600, Math.floor(cdRaw)))
        : Math.max(0, Math.min(3600, Number(existing.upload_cooldown_seconds) || 20))

      const newAdsId = String(payload?.ads_profile_id ?? '').trim() || null
      const prevAdsId = existing.ads_profile_id?.trim() ?? ''
      const prevName = existing.ads_profile_name?.trim() ?? ''
      let adsProfileName: string | null = prevName || null
      if (!newAdsId) {
        adsProfileName = null
      } else {
        const idChanged = newAdsId !== prevAdsId
        const nameMissing = !prevName
        if (idChanged || nameMissing) {
          try {
            const settings = getAppSettings()
            const apiBaseUrl =
              String(settings[SETTINGS_KEYS.adspower_api_base_url] ?? '').trim() ||
              'http://local.adspower.net:50325'
            const apiKey = String(settings[SETTINGS_KEYS.adspower_api_key] ?? '')
            const { displayName } = await fetchAdsProfileSummary({
              baseUrl: apiBaseUrl,
              apiKey,
              profileId: newAdsId
            })
            adsProfileName = displayName?.trim() || null
          } catch {
            adsProfileName = idChanged ? null : prevName || null
          }
        }
      }

      updateChannelPublishingSettings({
        channel_id: channelId,
        default_description: payload?.default_description ?? null,
        default_tags: payload?.default_tags ?? null,
        made_for_kids: Number(payload?.made_for_kids ?? 0) ? 1 : 0,
        default_category_id: category,
        default_language: language,
        publish_mode: mode,
        schedule_start_at: payload?.schedule_start_at ?? null,
        schedule_videos_per_day: perDay,
        schedule_window_start_hour: startHour,
        schedule_window_end_hour: endHour,
        schedule_randomize_minutes: randomMins,
        schedule_timezone: timezone,
        source_folder_path: sourceFolderPath,
        upload_cooldown_seconds: uploadCooldownSeconds,
        ads_profile_id: newAdsId,
        ads_profile_name: adsProfileName
      })
      logEvent({
        channel_id: channelId,
        level: 'info',
        action_type: 'channel_publish_settings_updated',
        message: `Параметры публикации обновлены (${mode === 'scheduled' ? 'отложка' : 'ручной режим'})`
      })
      return { ok: true as const, data: { channelId } }
    }
  )

  ipcMain.handle('dialog:openDirectory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const target = win ?? BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(target ?? undefined, {
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return r.filePaths[0]
  })

  ipcMain.handle(
    'dialog:openFile',
    async (event, payload?: { filters?: { name: string; extensions: string[] }[] }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const target = win ?? BrowserWindow.getFocusedWindow()
      const r = await dialog.showOpenDialog(target ?? undefined, {
        properties: ['openFile'],
        filters: payload?.filters
      })
      if (r.canceled || !r.filePaths[0]) return null
      return r.filePaths[0]
    }
  )

  ipcMain.handle('db:streamers:list', () => {
    const rows = listStreamers()
    return rows.map((r) => ({
      ...r,
      runtime_video_bitrate_kbps: getStreamerRuntimeVideoBitrateKbps(r.id),
      runtime_rtmp_via_proxy: getStreamerRuntimeUsedProxy(r.id)
    }))
  })

  ipcMain.handle('db:streamers:get', (_e, idRaw: unknown) => {
    const id = Number(idRaw)
    if (!Number.isFinite(id) || id < 1) return null
    return getStreamerById(id) ?? null
  })

  ipcMain.handle(
    'db:streamers:create',
    (_e, payload: { name: string; channel_id: number; proxy_id?: number | null }) => {
      const name = String(payload?.name ?? '').trim()
      const channelId = Number(payload?.channel_id)
      if (!name) return { ok: false, error: 'Укажите название стримера' } satisfies CreateResult<never>
      if (!Number.isFinite(channelId) || channelId < 1) {
        return { ok: false, error: 'Выберите канал' } satisfies CreateResult<never>
      }
      const ch = getChannelById(channelId)
      if (!ch) return { ok: false, error: 'Канал не найден' } satisfies CreateResult<never>
      const proxyId = normalizeProxyId(payload?.proxy_id)
      const { id } = insertStreamer({
        name,
        channel_id: channelId,
        proxy_id: proxyId
      })
      logEvent({
        channel_id: channelId,
        level: 'info',
        action_type: 'streamer_created',
        message: `Стример добавлен: ${name}`,
        metadata: { streamer_id: id }
      })
      return { ok: true as const, data: { id } }
    }
  )

  ipcMain.handle(
    'db:streamers:update',
    (
      _e,
      payload: {
        id: number
        name?: string
        channel_id?: number
        proxy_id?: number | null
        rtmp_ingest_url?: string
        rtmp_stream_key?: string
        overlay_path?: string | null
        segments_folder_path?: string | null
        stream_mode?: 'random' | 'ordered' | 'single'
        single_segment_path?: string | null
        bumper_video_path?: string | null
        bumper_pad_target_sec?: number | null
        video_bitrate_kbps?: number
        video_bitrate_mode?: 'cbr' | 'vbr'
        ffmpeg_extra_args?: string | null
        youtube_broadcast_id?: string | null
        broadcast_title?: string | null
        broadcast_description?: string | null
        broadcast_tags?: string | null
        broadcast_privacy?: string
        broadcast_category_id?: string
        broadcast_thumb_path?: string | null
        minecraft_prewarm_enabled?: number | boolean
        minecraft_prewarm_chunks_folder?: string | null
        minecraft_prewarm_audio_folder?: string | null
        minecraft_prewarm_music_path?: string | null
      }
    ) => {
      const id = Number(payload?.id)
      if (!Number.isFinite(id) || id < 1) return { ok: false, error: 'Некорректный id' } satisfies CreateResult<never>
      const existing = getStreamerById(id)
      if (!existing) return { ok: false, error: 'Стример не найден' } satisfies CreateResult<never>
      const patch: Parameters<typeof updateStreamer>[1] = {}
      if (payload.name !== undefined) patch.name = String(payload.name).trim()
      if (payload.channel_id !== undefined) {
        const cid = Number(payload.channel_id)
        if (!Number.isFinite(cid) || cid < 1) return { ok: false, error: 'Некорректный channel_id' } satisfies CreateResult<never>
        if (!getChannelById(cid)) return { ok: false, error: 'Канал не найден' } satisfies CreateResult<never>
        patch.channel_id = cid
      }
      if (payload.proxy_id !== undefined) patch.proxy_id = normalizeProxyId(payload.proxy_id)
      if (payload.rtmp_ingest_url !== undefined) patch.rtmp_ingest_url = String(payload.rtmp_ingest_url)
      if (payload.rtmp_stream_key !== undefined) patch.rtmp_stream_key = String(payload.rtmp_stream_key)
      if (payload.overlay_path !== undefined) {
        patch.overlay_path = sanitizeStreamerFsPathForDb(payload.overlay_path ?? null)
      }
      if (payload.segments_folder_path !== undefined) {
        patch.segments_folder_path = sanitizeStreamerFsPathForDb(payload.segments_folder_path ?? null)
      }
      if (payload.single_segment_path !== undefined) {
        patch.single_segment_path = sanitizeStreamerFsPathForDb(payload.single_segment_path ?? null)
      }
      if (payload.stream_mode !== undefined) {
        const m = payload.stream_mode
        patch.stream_mode = m === 'ordered' || m === 'single' ? m : 'random'
      }
      if (payload.bumper_video_path !== undefined) {
        patch.bumper_video_path = sanitizeStreamerFsPathForDb(payload.bumper_video_path ?? null)
      }
      if (payload.bumper_pad_target_sec !== undefined) {
        const raw = payload.bumper_pad_target_sec
        if (raw === null) patch.bumper_pad_target_sec = null
        else {
          const n = Number(raw)
          patch.bumper_pad_target_sec = Number.isFinite(n) ? n : null
        }
      }
      if (payload.video_bitrate_kbps !== undefined) {
        const raw = Number(payload.video_bitrate_kbps)
        if (!Number.isFinite(raw)) {
          return { ok: false, error: 'Некорректный video_bitrate_kbps' } satisfies CreateResult<never>
        }
        patch.video_bitrate_kbps = Math.max(200, Math.min(50000, Math.floor(raw)))
      }
      if (payload.video_bitrate_mode !== undefined) {
        patch.video_bitrate_mode = payload.video_bitrate_mode === 'vbr' ? 'vbr' : 'cbr'
      }
      if (payload.ffmpeg_extra_args !== undefined) patch.ffmpeg_extra_args = payload.ffmpeg_extra_args?.trim() || null
      if (payload.youtube_broadcast_id !== undefined) {
        patch.youtube_broadcast_id = payload.youtube_broadcast_id?.trim() || null
      }
      if (payload.broadcast_title !== undefined) patch.broadcast_title = payload.broadcast_title?.trim() || null
      if (payload.broadcast_description !== undefined) {
        patch.broadcast_description = payload.broadcast_description?.trim() || null
      }
      if (payload.broadcast_tags !== undefined) patch.broadcast_tags = payload.broadcast_tags?.trim() || null
      if (payload.broadcast_privacy !== undefined) {
        const p = String(payload.broadcast_privacy)
        patch.broadcast_privacy = p === 'public' || p === 'unlisted' ? p : 'private'
      }
      if (payload.broadcast_category_id !== undefined) {
        patch.broadcast_category_id = String(payload.broadcast_category_id).trim() || '22'
      }
      if (payload.broadcast_thumb_path !== undefined) {
        patch.broadcast_thumb_path = sanitizeStreamerFsPathForDb(payload.broadcast_thumb_path ?? null)
      }
      if (payload.minecraft_prewarm_enabled !== undefined) {
        const v = payload.minecraft_prewarm_enabled
        patch.minecraft_prewarm_enabled = v === true || v === 1 ? 1 : 0
      }
      if (payload.minecraft_prewarm_chunks_folder !== undefined) {
        patch.minecraft_prewarm_chunks_folder = sanitizeStreamerFsPathForDb(
          payload.minecraft_prewarm_chunks_folder ?? null
        )
      }
      if (payload.minecraft_prewarm_audio_folder !== undefined) {
        patch.minecraft_prewarm_audio_folder = sanitizeStreamerFsPathForDb(
          payload.minecraft_prewarm_audio_folder ?? null
        )
      }
      if (payload.minecraft_prewarm_music_path !== undefined) {
        patch.minecraft_prewarm_music_path = sanitizeStreamerFsPathForDb(
          payload.minecraft_prewarm_music_path ?? null
        )
      }
      updateStreamer(id, patch)
      if (existing.process_status === 'error') {
        updateStreamerProcessState(id, 'stopped', null)
      }
      logEvent({
        channel_id: existing.channel_id,
        level: 'info',
        action_type: 'streamer_updated',
        message: `Стример обновлён: ${existing.name}`,
        metadata: { streamer_id: id }
      })
      return { ok: true as const, data: { id } }
    }
  )

  ipcMain.handle('db:streamers:delete', async (_e, idRaw: unknown) => {
    const id = Number(idRaw)
    if (!Number.isFinite(id) || id < 1) return { ok: false, error: 'Некорректный id' } satisfies CreateResult<never>
    const row = getStreamerById(id)
    if (!row) return { ok: false, error: 'Стример не найден' } satisfies CreateResult<never>
    await stopStreamer(id)
    deleteStreamer(id)
    logEvent({
      channel_id: row.channel_id,
      level: 'warn',
      action_type: 'streamer_deleted',
      message: `Стример удалён: ${row.name}`,
      metadata: { streamer_id: id }
    })
    return { ok: true as const, data: { id } }
  })

  ipcMain.handle('streamers:start', async (_e, payload: { streamerId: number }) => {
    const streamerId = Number(payload?.streamerId)
    if (!Number.isFinite(streamerId) || streamerId < 1) {
      return { ok: false, error: 'Некорректный streamerId' } satisfies CreateResult<never>
    }
    const r = await startStreamer(streamerId)
    if (r.ok) {
      const row = getStreamerById(streamerId)
      const streamUrl = row?.youtube_broadcast_id?.trim() ? `https://www.youtube.com/watch?v=${row.youtube_broadcast_id.trim()}` : null
      logEvent({
        channel_id: row?.channel_id ?? null,
        level: 'info',
        action_type: 'streamer_started',
        message: `Запуск стримера #${streamerId}`,
        metadata: { streamer_id: streamerId, stream_url: streamUrl }
      })
    }
    return r
  })

  ipcMain.handle('streamers:stop', async (_e, payload: { streamerId: number }) => {
    const streamerId = Number(payload?.streamerId)
    if (!Number.isFinite(streamerId) || streamerId < 1) {
      return { ok: false, error: 'Некорректный streamerId' } satisfies CreateResult<never>
    }
    const rowStop = getStreamerById(streamerId)
    await stopStreamer(streamerId)
    logEvent({
      channel_id: rowStop?.channel_id ?? null,
      level: 'info',
      action_type: 'streamer_stopped',
      message: `Остановка стримера #${streamerId}`,
      metadata: { streamer_id: streamerId }
    })
    return { ok: true as const, data: { streamerId } }
  })

  ipcMain.handle(
    'streamers:openPreview',
    async (
      _e,
      payload: {
        channel_id?: number
        stream_mode?: 'random' | 'ordered' | 'single'
        segments_folder_path?: string | null
        single_segment_path?: string | null
        overlay_path?: string | null
        bumper_video_path?: string | null
        video_bitrate_kbps?: number
        video_bitrate_mode?: 'cbr' | 'vbr'
        ffmpeg_extra_args?: string | null
      }
    ) => {
      try {
        const mode = payload?.stream_mode === 'ordered' || payload?.stream_mode === 'single' ? payload.stream_mode : 'random'
        const bumperPath = String(payload?.bumper_video_path ?? '').trim()
        let videoPath = ''
        if (mode === 'single') {
          videoPath = String(payload?.single_segment_path ?? '').trim()
          if (!videoPath) {
            return { ok: false as const, error: 'Для режима «Один кусок» выберите mp4 файл' }
          }
        } else {
          const dir = String(payload?.segments_folder_path ?? '').trim()
          if (!dir) return { ok: false as const, error: 'Выберите папку с кусками' }
          const segsRaw = await collectSegmentVideos(dir)
          const segs = bumperPath
            ? segsRaw.filter((p) => p.trim().toLowerCase() !== bumperPath.toLowerCase())
            : segsRaw
          if (segsRaw.length > 0 && segs.length < 1) {
            return { ok: false as const, error: 'В папке осталась только заглушка, выберите рабочие куски видео' }
          }
          if (segs.length < 1) return { ok: false as const, error: 'В папке нет видеофайлов' }
          videoPath = segs[0]!
        }
        const videoFramePath = await captureSingleFrameImage(videoPath, 'video')
        let overlayFramePath: string | null = null
        const overlay = String(payload?.overlay_path ?? '').trim()
        if (overlay) {
          try {
            overlayFramePath = await captureSingleFrameImage(overlay, 'overlay')
          } catch {
            overlayFramePath = null
          }
        }
        const channelId = Number(payload?.channel_id)
        const ch = Number.isFinite(channelId) && channelId > 0 ? getChannelById(channelId) : null
        await openStreamPreviewWindow({
          videoFramePath,
          overlayFramePath,
          initialLayoutJson: ch?.stream_preview_layout_json ?? null,
          onSave: (layoutJson) => {
            if (ch?.id) updateChannelStreamPreviewLayout(ch.id, layoutJson)
          },
          onRenderMinute: async (layoutJson, onProgress) => {
            const concatListPath = await buildPreviewRenderConcatList(payload)
            const materialized = { layoutJson: layoutJson || ch?.stream_preview_layout_json || '', tempFiles: [] as string[] }
            try {
              const rendersDir = join(process.cwd(), 'renders')
              await fsp.mkdir(rendersDir, { recursive: true })
              const outPath = join(rendersDir, `preview-render-${Date.now()}.mp4`)
              const bitrateKbps = Math.max(200, Math.min(50000, Math.floor(Number(payload?.video_bitrate_kbps) || 6000)))
              const bitrateMode = payload?.video_bitrate_mode === 'vbr' ? 'vbr' : 'cbr'
              const hydrated = await materializeLayoutDataUrlSources(layoutJson || ch?.stream_preview_layout_json || '')
              materialized.layoutJson = hydrated.layoutJson
              materialized.tempFiles = hydrated.tempFiles
              const streamArgs = buildFfmpegStreamArgs({
                concatListPath,
                outputRtmpUrl: 'rtmp://127.0.0.1/live/preview-render',
                overlayPath: String(payload?.overlay_path ?? '').trim() || null,
                videoBitrateKbps: bitrateKbps,
                videoBitrateMode: bitrateMode,
                extraArgs: payload?.ffmpeg_extra_args?.trim() || null,
                streamPreviewLayoutJson: materialized.layoutJson || null
              })
              const renderArgs = toMp4FileArgs(streamArgs, outPath, 60)
              await renderMinuteWithProgress({ args: renderArgs, totalSec: 60, onProgress })
              void shell.showItemInFolder(outPath)
              return outPath
            } finally {
              for (const p of materialized.tempFiles) {
                await unlinkQuiet(p)
              }
              await unlinkQuiet(concatListPath)
            }
          }
        })
        return { ok: true as const }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.handle(
    'streamers:applyBroadcastMeta',
    async (
      _e,
      payload: {
        streamerId: number
        youtube_broadcast_id?: string | null
        broadcast_title?: string | null
        broadcast_description?: string | null
        broadcast_tags?: string | null
        broadcast_privacy?: string
        broadcast_category_id?: string
        broadcast_thumb_path?: string | null
      }
    ) => {
      const streamerId = Number(payload?.streamerId)
      if (!Number.isFinite(streamerId) || streamerId < 1) {
        return { ok: false, error: 'Некорректный streamerId' } satisfies CreateResult<never>
      }
      const row = getStreamerById(streamerId)
      if (!row) return { ok: false, error: 'Стример не найден' } satisfies CreateResult<never>
      const bidRaw =
        payload.youtube_broadcast_id !== undefined ? payload.youtube_broadcast_id : row.youtube_broadcast_id
      const bid = typeof bidRaw === 'string' ? bidRaw.trim() : ''
      if (!bid) {
        return { ok: false, error: 'Укажите Broadcast ID (или нажмите «Подставить с YouTube»)' } satisfies CreateResult<never>
      }
      const title =
        (payload.broadcast_title !== undefined ? payload.broadcast_title : row.broadcast_title)?.trim() || null
      const description =
        (payload.broadcast_description !== undefined ? payload.broadcast_description : row.broadcast_description)?.trim() ||
        null
      const tagsStr =
        (payload.broadcast_tags !== undefined ? payload.broadcast_tags : row.broadcast_tags)?.trim() || null
      const tags = (tagsStr ?? '')
        .split(/[,;]/)
        .map((t) => t.trim())
        .filter(Boolean)
      const pRaw = payload.broadcast_privacy !== undefined ? payload.broadcast_privacy : row.broadcast_privacy
      const privacy = pRaw === 'public' || pRaw === 'unlisted' ? pRaw : 'private'
      const categoryId =
        payload.broadcast_category_id !== undefined
          ? String(payload.broadcast_category_id).trim() || '22'
          : row.broadcast_category_id || '22'
      const broadcast_thumb_path =
        payload.broadcast_thumb_path !== undefined
          ? sanitizeStreamerFsPathForDb(payload.broadcast_thumb_path ?? null)
          : row.broadcast_thumb_path ?? null
      try {
        const creds = getOAuthClientCredentialsForChannel(row.channel_id)
        if (!creds.channel.oauth_refresh_token) {
          return { ok: false, error: 'Канал без OAuth' } satisfies CreateResult<never>
        }
        const ch = creds.channel
        const { debugLog } = await updateLiveBroadcastMetadata({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          refreshToken: ch.oauth_refresh_token,
          accessToken: ch.oauth_access_token,
          proxy: creds.proxy ?? null,
          broadcastId: bid,
          title,
          description,
          tags,
          privacyStatus: privacy,
          categoryId,
          selfDeclaredMadeForKids: Boolean(ch.made_for_kids),
          thumbnailImagePath: broadcast_thumb_path
        })
        updateStreamer(streamerId, {
          youtube_broadcast_id: bid,
          broadcast_title: title,
          broadcast_description: description,
          broadcast_tags: tagsStr,
          broadcast_privacy: privacy,
          broadcast_category_id: categoryId,
          broadcast_thumb_path
        })
        logEvent({
          channel_id: row.channel_id,
          level: 'info',
          action_type: 'streamer_broadcast_meta',
          message: `Метаданные эфира обновлены (broadcast ${bid})`,
          metadata: { streamer_id: streamerId }
        })
        return { ok: true as const, data: { streamerId, debugLog } }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const debugLog = formatYoutubeApiError(e)
        const scopeProblem =
          /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(
            `${message}\n${debugLog}`
          )
        const hint = scopeProblem
          ? '\n\nЧто сделать: в разделе «Каналы» заново подключите YouTube к этому каналу (отключить → подключить), в окне Google разрешите все запрошенные права. В Google Cloud → OAuth consent screen в списке областей должны быть полные права YouTube: https://www.googleapis.com/auth/youtube (или youtube.force-ssl), а не только https://www.googleapis.com/auth/youtube.upload — upload не даёт править эфир и метаданные Live.'
          : ''
        logEvent({
          channel_id: row.channel_id,
          level: 'error',
          action_type: 'streamer_broadcast_meta_failed',
          message
        })
        return { ok: false, error: `${message}${hint}`, debugLog }
      }
    }
  )

  ipcMain.handle('streamers:suggestBroadcastId', async (_e, payload: { streamerId: number }) => {
    const streamerId = Number(payload?.streamerId)
    if (!Number.isFinite(streamerId) || streamerId < 1) {
      return { ok: false, error: 'Некорректный streamerId' } satisfies CreateResult<never>
    }
    const row = getStreamerById(streamerId)
    if (!row) return { ok: false, error: 'Стример не найден' } satisfies CreateResult<never>
    try {
      const creds = getOAuthClientCredentialsForChannel(row.channel_id)
      if (!creds.channel.oauth_refresh_token) {
        return { ok: false, error: 'Канал без OAuth' } satisfies CreateResult<never>
      }
      const ch = creds.channel
      const hit = await suggestLiveBroadcastId({
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        refreshToken: ch.oauth_refresh_token,
        accessToken: ch.oauth_access_token,
        proxy: creds.proxy ?? null
      })
      if (!hit) {
        return {
          ok: false,
          error:
            'Не найдено подходящих эфиров (ожидание / эфир / тест). Создайте трансляцию в YouTube Studio или вставьте Broadcast ID из URL редактирования эфира.'
        } satisfies CreateResult<never>
      }
      updateStreamer(streamerId, { youtube_broadcast_id: hit.broadcastId })
      return { ok: true as const, data: hit }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('app:openExternalUrl', (_e, payload: { url: string }) => {
    const raw = String(payload?.url ?? '').trim()
    if (!raw) return { ok: false as const, error: 'Пустой URL' }
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return { ok: false as const, error: 'Некорректный URL' }
    }
    if (u.protocol !== 'https:') {
      return { ok: false as const, error: 'Разрешён только https://' }
    }
    const host = u.hostname.toLowerCase()
    const allowed =
      host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com' || host.endsWith('.youtube.com')
    if (!allowed) {
      return { ok: false as const, error: 'Разрешены только ссылки на youtube.com / youtu.be' }
    }
    void shell.openExternal(raw)
    return { ok: true as const }
  })

  ipcMain.handle('app:bootstrap', () => {
    logEvent({
      level: 'info',
      action_type: 'app_started',
      message: 'Приложение запущено'
    })
    return { ok: true as const }
  })
}
