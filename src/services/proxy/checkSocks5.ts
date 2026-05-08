import https from 'node:https'
import { SocksProxyAgent } from 'socks-proxy-agent'

export type Socks5CheckResult =
  | {
      ok: true
      ip: string
      country: string
      /** ISO 3166-1 alpha-2 из ipwho.is (для флага в UI). */
      country_code?: string
      city: string
      region: string
      isp?: string
    }
  | { ok: false; error: string }

export type Socks5UploadSpeedResult =
  | {
      ok: true
      upload_mbps_avg: number
      upload_test_sec: number
    }
  | { ok: false; error: string }

function buildSocks5Url(
  host: string,
  port: number,
  login?: string | null,
  password?: string | null
): string {
  const h = host.trim()
  const user = login?.trim()
  const pass = password ?? ''
  if (user && pass !== '') {
    return `socks5://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${h}:${port}`
  }
  if (user) {
    return `socks5://${encodeURIComponent(user)}@${h}:${port}`
  }
  return `socks5://${h}:${port}`
}

function httpsGet(url: string, agent: SocksProxyAgent, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent }, (res) => {
      let body = ''
      res.on('data', (c) => {
        body += c
      })
      res.on('end', () => {
        clearTimeout(t)
        resolve(body)
      })
    })
    const t = setTimeout(() => {
      req.destroy(new Error(`Таймаут ${timeoutMs} мс`))
    }, timeoutMs)
    req.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

async function measureSocks5UploadMbps(input: {
  agent: SocksProxyAgent
  timeoutMs: number
  durationSec: number
}): Promise<{ mbpsAvg: number; elapsedSec: number }> {
  const { agent, timeoutMs, durationSec } = input
  const targetMs = Math.max(1, Math.floor(durationSec * 1000))
  const chunk = Buffer.alloc(64 * 1024, 120)
  const startedAt = Date.now()
  let bytesWritten = 0

  const elapsedMs = (): number => Date.now() - startedAt

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      'https://httpbin.org/post',
      {
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/octet-stream',
          'transfer-encoding': 'chunked',
          connection: 'close'
        }
      },
      (res) => {
        res.on('data', () => {
          /* ignore body */
        })
        res.on('end', () => resolve())
      }
    )
    const killer = setTimeout(() => {
      req.destroy(new Error(`Таймаут upload-теста ${timeoutMs} мс`))
    }, timeoutMs)
    req.on('error', (e) => {
      clearTimeout(killer)
      reject(e)
    })
    req.on('close', () => {
      clearTimeout(killer)
    })

    const pump = (): void => {
      while (elapsedMs() < targetMs) {
        const ok = req.write(chunk)
        bytesWritten += chunk.length
        if (!ok) {
          req.once('drain', pump)
          return
        }
      }
      req.end()
    }
    pump()
  })

  const elapsedSec = Math.max(0.001, elapsedMs() / 1000)
  const mbpsAvg = (bytesWritten * 8) / elapsedSec / 1_000_000
  return { mbpsAvg, elapsedSec }
}

export async function checkSocks5UrlReachability(opts: {
  host: string
  port: number
  login?: string | null
  password?: string | null
  url: string
  timeoutMs?: number
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const timeoutMs = opts.timeoutMs ?? 15000
  try {
    const u = buildSocks5Url(opts.host, opts.port, opts.login, opts.password)
    const agent = new SocksProxyAgent(u, { timeout: timeoutMs })
    await httpsGet(opts.url, agent, timeoutMs)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Проверка SOCKS5: запрос наружу через прокси — IP (ipify) и гео (ipwho.is).
 */
export async function checkSocks5Proxy(opts: {
  host: string
  port: number
  login?: string | null
  password?: string | null
  timeoutMs?: number
}): Promise<Socks5CheckResult> {
  const timeoutMs = opts.timeoutMs ?? 20000
  let agent: SocksProxyAgent
  try {
    const u = buildSocks5Url(opts.host, opts.port, opts.login, opts.password)
    agent = new SocksProxyAgent(u, { timeout: timeoutMs })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  try {
    const ipRaw = await httpsGet('https://api.ipify.org?format=json', agent, timeoutMs)
    const ipParsed = JSON.parse(ipRaw) as { ip?: string }
    const ip = ipParsed.ip?.trim()
    if (!ip) {
      return { ok: false, error: 'Пустой ответ IP' }
    }

    const geoRaw = await httpsGet(`https://ipwho.is/${encodeURIComponent(ip)}`, agent, timeoutMs)
    const geo = JSON.parse(geoRaw) as {
      success?: boolean
      message?: string
      country?: string
      country_code?: string
      city?: string
      region?: string
      connection?: { isp?: string }
    }

    if (geo.success === false) {
      return {
        ok: true,
        ip,
        country: '?',
        country_code: typeof geo.country_code === 'string' ? geo.country_code : undefined,
        city: '?',
        region: geo.message ?? '?',
        isp: geo.connection?.isp
      }
    }

    const cc =
      typeof geo.country_code === 'string' && /^[A-Za-z]{2}$/.test(geo.country_code)
        ? geo.country_code.toUpperCase()
        : undefined

    return {
      ok: true,
      ip,
      country: geo.country ?? '?',
      country_code: cc,
      city: geo.city ?? '?',
      region: geo.region ?? '?',
      isp: geo.connection?.isp
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

export async function checkSocks5ProxyUploadSpeed(opts: {
  host: string
  port: number
  login?: string | null
  password?: string | null
  timeoutMs?: number
  durationSec?: number
}): Promise<Socks5UploadSpeedResult> {
  const timeoutMs = opts.timeoutMs ?? 35000
  const durationSec = opts.durationSec ?? 12
  try {
    const u = buildSocks5Url(opts.host, opts.port, opts.login, opts.password)
    const agent = new SocksProxyAgent(u, { timeout: timeoutMs })
    const uploadProbe = await measureSocks5UploadMbps({ agent, timeoutMs, durationSec })
    return {
      ok: true,
      upload_mbps_avg: Number(uploadProbe.mbpsAvg.toFixed(2)),
      upload_test_sec: Number(uploadProbe.elapsedSec.toFixed(1))
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
