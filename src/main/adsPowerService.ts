import { chromium } from 'playwright-core'

type AdsPowerWs = {
  selenium?: string
  puppeteer?: string
}

type AdsProxyConfig = {
  proxy_soft?: string
  proxy_type?: string
  proxy_host?: string
  proxy_port?: string
  proxy_user?: string
  proxy_password?: string
}

type AdsProfileItem = {
  profile_id?: string
  /** Имя профиля в ADS (поля в API могут отличаться по версии). */
  name?: string
  profile_name?: string
  user_name?: string
  remark?: string
  user_proxy_config?: AdsProxyConfig
}

type AdsPowerStartData = {
  ws?: AdsPowerWs
  debug_port?: string
  webdriver?: string
}

type AdsPowerProfileListData = {
  list?: AdsProfileItem[]
}

type AdsPowerResponse<T> = {
  code: number
  msg?: string
  data?: T
}

type AdsPowerActiveData = {
  ws?: AdsPowerWs
  debug_port?: string
  webdriver?: string
}

function normalizeBaseUrl(input: string): string {
  const raw = input.trim() || 'http://local.adspower.net:50325'
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

async function callAdsPower<T>(input: {
  baseUrl: string
  path: string
  method: 'GET' | 'POST'
  apiKey: string
  body?: Record<string, unknown>
}): Promise<AdsPowerResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (input.apiKey.trim()) {
    headers.Authorization = `Bearer ${input.apiKey.trim()}`
  }
  const res = await fetch(`${normalizeBaseUrl(input.baseUrl)}${input.path}`, {
    method: input.method,
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined
  })
  const text = await res.text()
  let parsed: AdsPowerResponse<T> | null = null
  try {
    parsed = JSON.parse(text) as AdsPowerResponse<T>
  } catch {
    throw new Error(`ADS API вернул не-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    throw new Error(`ADS API HTTP ${res.status}: ${parsed.msg ?? 'unknown error'}`)
  }
  return parsed
}

function pickAdsProfileDisplayName(profile: AdsProfileItem): string | null {
  for (const k of ['name', 'profile_name', 'user_name', 'remark'] as const) {
    const raw = (profile as Record<string, unknown>)[k]
    const v = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim()
    if (v) return v
  }
  return null
}

export type AdsProfileProxyParsed =
  | {
      type: string
      host: string
      port: number
      login: string | null
      password: string | null
    }
  | null

/**
 * Один запрос к `/api/v2/browser-profile/list`: имя профиля + SOCKS/прокси из user_proxy_config.
 */
export async function fetchAdsProfileSummary(input: {
  baseUrl: string
  apiKey: string
  profileId: string
}): Promise<{ displayName: string | null; proxy: AdsProfileProxyParsed }> {
  const profileId = input.profileId.trim()
  if (!profileId) throw new Error('Не указан ADS profile id')

  const res = await callAdsPower<AdsPowerProfileListData>({
    baseUrl: input.baseUrl,
    path: '/api/v2/browser-profile/list',
    method: 'POST',
    apiKey: input.apiKey,
    body: {
      profile_id: [profileId],
      page: 1,
      limit: 1
    }
  })
  if (res.code !== 0) throw new Error(`ADS не отдал профиль: ${res.msg ?? 'unknown error'}`)
  const profile = res.data?.list?.[0]
  if (!profile) return { displayName: null, proxy: null }

  const displayName = pickAdsProfileDisplayName(profile)
  const cfg = profile.user_proxy_config
  if (!cfg) return { displayName, proxy: null }

  const proxySoft = String(cfg.proxy_soft ?? '').trim().toLowerCase()
  if (!proxySoft || proxySoft === 'no_proxy') return { displayName, proxy: null }

  const type = String(cfg.proxy_type ?? '').trim().toLowerCase()
  const host = String(cfg.proxy_host ?? '').trim()
  const portRaw = Number.parseInt(String(cfg.proxy_port ?? '').trim(), 10)
  if (!host || !Number.isFinite(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new Error('ADS вернул неполные данные прокси (host/port)')
  }
  return {
    displayName,
    proxy: {
      type: type || 'http',
      host,
      port: portRaw,
      login: String(cfg.proxy_user ?? '').trim() || null,
      password: String(cfg.proxy_password ?? '') || null
    }
  }
}

export async function startAdsProfileAndOpenUrl(input: {
  baseUrl: string
  apiKey: string
  profileId: string
  url: string
  /** Открыть URL в новой вкладке (обычно справа / последней в ADS Chromium). */
  openInNewTab?: boolean
}): Promise<{ debugPort: string | null }> {
  const profileId = input.profileId.trim()
  if (!profileId) throw new Error('Не указан ADS profile id')

  const started = await callAdsPower<AdsPowerStartData>({
    baseUrl: input.baseUrl,
    path: '/api/v2/browser-profile/start',
    method: 'POST',
    apiKey: input.apiKey,
    body: {
      profile_id: profileId,
      last_opened_tabs: '1',
      proxy_detection: '0'
    }
  })

  const isAlreadyRunningError = /already|running|opened|launched|start.*fail/i.test(String(started.msg ?? ''))
  let sessionData = started.data
  if (started.code !== 0 && isAlreadyRunningError) {
    // Profile may already be running: request active session and reuse its CDP endpoint.
    const active = await callAdsPower<AdsPowerActiveData>({
      baseUrl: input.baseUrl,
      path: '/api/v2/browser-profile/active',
      method: 'POST',
      apiKey: input.apiKey,
      body: { profile_id: profileId }
    })
    if (active.code !== 0) {
      throw new Error(`ADS не вернул активную сессию профиля: ${active.msg ?? started.msg ?? 'unknown error'}`)
    }
    sessionData = active.data
  } else if (started.code !== 0) {
    throw new Error(`ADS не запустил профиль: ${started.msg ?? 'unknown error'}`)
  }

  const wsEndpoint = sessionData?.ws?.puppeteer?.trim() ?? ''
  if (!wsEndpoint) {
    throw new Error('ADS не вернул ws.puppeteer endpoint для профиля')
  }

  const browser = await chromium.connectOverCDP(wsEndpoint)
  try {
    const context = browser.contexts()[0]
    if (!context) throw new Error('Не удалось получить контекст браузера ADS')
    const page = input.openInNewTab ? await context.newPage() : context.pages()[0] ?? (await context.newPage())
    await page.bringToFront().catch(() => {})
    await page.goto(input.url, { waitUntil: 'domcontentloaded' })
  } finally {
    await browser.close()
  }

  return {
    debugPort: sessionData?.debug_port ?? null
  }
}
