import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import googleapis from 'googleapis'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { ProxyRow } from '@services/db/types'

const { google } = googleapis

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
