import { createReadStream } from 'node:fs'
import https from 'node:https'
import { basename } from 'node:path'
import googleapis from 'googleapis'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { ProxyRow } from '@services/db/types'

const { google } = googleapis

function httpsRequest(input: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  agent?: SocksProxyAgent
  timeoutMs?: number
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(input.url)
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : undefined,
        path: `${u.pathname}${u.search}`,
        method: input.method,
        headers: input.headers,
        agent: input.agent
      },
      (res) => {
        let body = ''
        res.on('data', (c) => {
          body += c.toString('utf8')
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body
          })
        })
      }
    )
    const t = setTimeout(() => req.destroy(new Error(`HTTP timeout ${input.timeoutMs ?? 20000} ms`)), input.timeoutMs ?? 20000)
    req.on('error', reject)
    req.on('close', () => clearTimeout(t))
    if (input.body) req.write(input.body)
    req.end()
  })
}

function buildSocks5Url(proxy: ProxyRow): string {
  const h = proxy.host.trim()
  const user = proxy.login?.trim()
  const pass = proxy.password ?? ''
  if (user && pass !== '') return `socks5://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${h}:${proxy.port}`
  if (user) return `socks5://${encodeURIComponent(user)}@${h}:${proxy.port}`
  return `socks5://${h}:${proxy.port}`
}

export async function uploadVideoToYouTube(input: {
  clientId: string
  clientSecret: string
  refreshToken: string
  accessToken?: string | null
  proxy?: ProxyRow | null
  filePath: string
  title?: string
  description?: string
  tags?: string[]
  madeForKids?: boolean
  categoryId?: string
  defaultLanguage?: string
  privacyStatus?: 'private' | 'public' | 'unlisted'
  publishAt?: string | null
}): Promise<{ videoId: string }> {
  const oauth2 = new google.auth.OAuth2(input.clientId, input.clientSecret)
  oauth2.setCredentials({
    refresh_token: input.refreshToken,
    access_token: input.accessToken ?? undefined
  })
  if (input.proxy) {
    const agent = new SocksProxyAgent(buildSocks5Url(input.proxy))
    google.options({ agent })
  } else {
    google.options({ agent: undefined })
  }

  const yt = google.youtube({ version: 'v3', auth: oauth2 })
  const fileName = basename(input.filePath)
  const title = input.title?.trim() || fileName
  const description = input.description?.trim() || ''
  const privacyStatus = input.privacyStatus ?? 'private'
  const categoryId = input.categoryId?.trim() || '22'
  const defaultLanguage = input.defaultLanguage?.trim() || 'ru'
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean)
  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        categoryId,
        defaultLanguage,
        defaultAudioLanguage: defaultLanguage,
        tags: tags.length ? tags : undefined
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: input.madeForKids ?? false,
        publishAt: privacyStatus === 'private' && input.publishAt ? input.publishAt : undefined
      }
    },
    media: { body: createReadStream(input.filePath) }
  })
  const videoId = res.data.id ?? ''
  if (!videoId) throw new Error('YouTube API не вернул videoId')
  return { videoId }
}

export async function checkYouTubeUploadHandshake(input: {
  clientId: string
  clientSecret: string
  refreshToken: string
  accessToken?: string | null
  proxy?: ProxyRow | null
}): Promise<{ ok: true; resumableSessionStarted: true } | { ok: false; error: string }> {
  try {
    const oauth2 = new google.auth.OAuth2(input.clientId, input.clientSecret)
    oauth2.setCredentials({
      refresh_token: input.refreshToken,
      access_token: input.accessToken ?? undefined
    })
    const at = await oauth2.getAccessToken()
    const accessToken = typeof at === 'string' ? at : at?.token
    if (!accessToken) return { ok: false, error: 'Не удалось получить access_token для проверки' }
    const agent = input.proxy ? new SocksProxyAgent(buildSocks5Url(input.proxy)) : undefined
    const meta = JSON.stringify({
      snippet: { title: `oauth-check-${Date.now()}`, categoryId: '22', defaultLanguage: 'ru' },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false }
    })
    const initRes = await httpsRequest({
      method: 'POST',
      url: 'https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': '1'
      },
      body: meta,
      agent,
      timeoutMs: 25000
    })
    if (initRes.status < 200 || initRes.status >= 300) {
      return { ok: false, error: initRes.body || `HTTP ${initRes.status}` }
    }
    const location = Array.isArray(initRes.headers.location) ? initRes.headers.location[0] : initRes.headers.location
    if (location) {
      // Best-effort cancel of session to avoid accidental upload completion.
      void httpsRequest({
        method: 'DELETE',
        url: location,
        headers: { Authorization: `Bearer ${accessToken}` },
        agent,
        timeoutMs: 10000
      }).catch(() => {})
    }
    return { ok: true, resumableSessionStarted: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
