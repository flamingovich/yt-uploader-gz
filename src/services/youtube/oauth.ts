import http from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { URL } from 'node:url'
import googleapis from 'googleapis'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { ProxyRow } from '@services/db/types'

/**
 * Полный доступ к каналу: загрузка, Live (эфиры, метаданные), правки видео.
 * `youtube` + `youtube.force-ssl` — оба перечислены в документации для записи (в т.ч. liveBroadcasts / videos.update).
 * Если раньше выдавали токен только с `youtube.upload`, без повторного входа будет 403 insufficient scopes.
 */
export const YOUTUBE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl'
]
const { google } = googleapis

function buildSocks5Url(proxy: ProxyRow): string {
  const h = proxy.host.trim()
  const user = proxy.login?.trim()
  const pass = proxy.password ?? ''
  if (user && pass !== '') return `socks5://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${h}:${proxy.port}`
  if (user) return `socks5://${encodeURIComponent(user)}@${h}:${proxy.port}`
  return `socks5://${h}:${proxy.port}`
}

function createPkce() {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

async function createOAuthReceiver(state: string, timeoutMs = 180000): Promise<{
  redirectUri: string
  waitCode: Promise<string>
}> {
  const redirectPath = '/oauth2callback'
  return new Promise((resolve, reject) => {
    let done = false
    const server = http.createServer((req, res) => {
      const finish = (code?: string, error?: string) => {
        if (done) return
        done = true
        clearTimeout(timer)
        server.close()
        if (error) {
          reject(new Error(error))
        } else if (code) {
          resolveObj?.(code)
        }
      }

      try {
        const host = req.headers.host ?? '127.0.0.1'
        const parsed = new URL(req.url ?? '/', `http://${host}`)
        if (parsed.pathname !== redirectPath) {
          res.statusCode = 404
          res.end('Not found')
          return
        }
        const gotState = parsed.searchParams.get('state')
        const code = parsed.searchParams.get('code')
        if (!code || !gotState || gotState !== state) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end('OAuth state/code invalid')
          finish(undefined, 'Некорректный OAuth ответ: state/code')
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<html><body style="font-family: sans-serif; background:#0f0f0f; color:#e5e5e5;">Авторизация успешна. Можно закрыть окно.</body></html>')
        finish(code)
      } catch (e) {
        finish(undefined, e instanceof Error ? e.message : String(e))
      }
    })

    const timer = setTimeout(() => {
      if (done) return
      done = true
      server.close()
      reject(new Error('Таймаут OAuth авторизации (3 минуты).'))
    }, timeoutMs)

    let resolveObj: ((code: string) => void) | null = null
    const waitCode = new Promise<string>((res) => {
      resolveObj = res
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const redirectUri = `http://127.0.0.1:${port}${redirectPath}`
      resolve({ redirectUri, waitCode })
    })
  })
}

export async function authorizeYouTubeChannel(input: {
  clientId: string
  clientSecret: string
  proxy?: ProxyRow | null
  openExternal(url: string): Promise<{ close: () => void } | void> | { close: () => void } | void
}): Promise<{
  accessToken: string
  refreshToken: string | null
  expiryDateIso: string | null
  youtubeChannelId: string
  youtubeChannelTitle: string
}> {
  const state = randomBytes(24).toString('hex')
  const { codeVerifier, codeChallenge } = createPkce()
  const receiver = await createOAuthReceiver(state)
  const oauth2 = new google.auth.OAuth2(input.clientId, input.clientSecret, receiver.redirectUri)
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: YOUTUBE_OAUTH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  })
  const openerResult = await input.openExternal(authUrl)
  const code = await receiver.waitCode
  if (openerResult && typeof openerResult === 'object' && 'close' in openerResult) {
    openerResult.close()
  }
  if (input.proxy) {
    const agent = new SocksProxyAgent(buildSocks5Url(input.proxy))
    google.options({ agent })
  }
  const tokenResp = await oauth2.getToken({ code, codeVerifier })
  const accessToken = tokenResp.tokens.access_token ?? ''
  if (!accessToken) throw new Error('Google не вернул access_token')
  oauth2.setCredentials(tokenResp.tokens)
  const yt = google.youtube({ version: 'v3', auth: oauth2 })
  const mine = await yt.channels.list({ part: ['id', 'snippet'], mine: true })
  const ch = mine.data.items?.[0]
  if (!ch?.id) throw new Error('Не удалось получить канал YouTube по OAuth')
  return {
    accessToken,
    refreshToken: tokenResp.tokens.refresh_token ?? null,
    expiryDateIso: tokenResp.tokens.expiry_date ? new Date(tokenResp.tokens.expiry_date).toISOString() : null,
    youtubeChannelId: ch.id,
    youtubeChannelTitle: ch.snippet?.title ?? 'YouTube Channel'
  }
}
