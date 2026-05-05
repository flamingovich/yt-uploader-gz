import { AlertCircle, Globe } from 'lucide-react'
import { useState } from 'react'

export type ParsedProxyCheck =
  | { state: 'unknown' }
  | { state: 'ok'; countryCode: string | null; country: string; ip: string }
  | { state: 'fail'; error: string }

export function parseProxyLastCheckJson(raw: string | null): ParsedProxyCheck {
  if (!raw?.trim()) return { state: 'unknown' }
  try {
    const j = JSON.parse(raw) as {
      ok?: boolean
      country?: string
      country_code?: string
      ip?: string
      error?: string
    }
    if (j.ok === true) {
      const cc =
        typeof j.country_code === 'string' && /^[A-Za-z]{2}$/.test(j.country_code)
          ? j.country_code.toUpperCase()
          : null
      return {
        state: 'ok',
        countryCode: cc,
        country: String(j.country ?? '?'),
        ip: String(j.ip ?? '')
      }
    }
    if (j.ok === false) {
      return { state: 'fail', error: String(j.error ?? 'Ошибка проверки') }
    }
  } catch {
    /* ignore */
  }
  return { state: 'unknown' }
}

/** PNG-флаг по ISO2 (не эмодзи — на Windows без цветных эмодзи не превращается в «PL»). */
function ProxyCountryFlagImg(props: { code: string; title: string; className?: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const lc = props.code.toLowerCase()
  if (failed) {
    return (
      <span title={props.title} className={props.className}>
        <Globe className="h-5 w-5 shrink-0 text-industrial-muted" strokeWidth={1.75} aria-hidden />
      </span>
    )
  }
  return (
    <img
      src={`https://flagcdn.com/24x18/${lc}.png`}
      srcSet={`https://flagcdn.com/48x36/${lc}.png 2x`}
      width={24}
      height={18}
      alt=""
      title={props.title}
      className={`h-[18px] w-6 shrink-0 rounded-sm border border-industrial-border/50 object-cover ${props.className ?? ''}`}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}

export function ProxyStatusGlyph(props: { lastCheckStatus: string | null; className?: string }): JSX.Element {
  const p = parseProxyLastCheckJson(props.lastCheckStatus)
  const base = props.className ?? ''
  if (p.state === 'unknown') {
    return (
      <span
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-industrial-border/60 bg-industrial-bg text-[10px] text-industrial-dim ${base}`}
        title="Прокси ещё не проверяли"
      >
        …
      </span>
    )
  }
  if (p.state === 'fail') {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center ${base}`} title={p.error}>
        <AlertCircle className="h-5 w-5 text-red-400" strokeWidth={2} aria-hidden />
      </span>
    )
  }
  if (p.countryCode) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center ${base}`}>
        <ProxyCountryFlagImg code={p.countryCode} title={`${p.country} · ${p.ip}`} />
      </span>
    )
  }
  return (
    <span className={`inline-flex shrink-0 text-sm leading-none text-industrial-muted ${base}`} title={p.country}>
      <Globe className="h-5 w-5" strokeWidth={1.5} aria-hidden />
    </span>
  )
}
