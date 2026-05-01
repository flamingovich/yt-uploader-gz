import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

type ProxyRow = Awaited<ReturnType<typeof window.electronAPI.db.listProxies>>[number]
type CreateProxyResult = Awaited<ReturnType<typeof window.electronAPI.db.createProxy>>
type CreateBulkProxyResult = Awaited<ReturnType<typeof window.electronAPI.db.createBulkProxies>>
type CheckResult = Awaited<ReturnType<typeof window.electronAPI.proxy.check>>
type ProxyMode = 'single' | 'bulk'

function parseCompactProxyLine(raw: string): { host: string; port: string; login: string; password: string } | null {
  const parts = raw.trim().split(':')
  if (parts.length !== 4) return null
  const host = parts[0]?.trim() ?? ''
  const port = parts[1]?.trim() ?? ''
  const login = parts[2]?.trim() ?? ''
  const password = parts[3] ?? ''
  if (!host || !port) return null
  if (!/^\d+$/.test(port)) return null
  return { host, port, login, password }
}

function formatLastCheck(raw: string | null): string {
  if (!raw) return '—'
  try {
    const j = JSON.parse(raw) as CheckResult
    if (j.ok) {
      return `${j.ip} · ${j.country}, ${j.city}`
    }
    return `ошибка: ${j.error}`
  } catch {
    return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw
  }
}

export function ProxiesPage(): JSX.Element {
  const [rows, setRows] = useState<ProxyRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [bulkResult, setBulkResult] = useState<string | null>(null)
  const [mode, setMode] = useState<ProxyMode>('single')
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('1080')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [bulkLines, setBulkLines] = useState('')
  const [bulkNamePrefix, setBulkNamePrefix] = useState('Proxy')
  const [formCheck, setFormCheck] = useState<CheckResult | null>(null)
  const [checking, setChecking] = useState<'form' | number | 'bulk' | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)

  const reload = useCallback(async () => {
    setRows(await window.electronAPI.db.listProxies())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  async function runCheck(args: {
    host?: string
    port?: number
    login?: string | null
    password?: string | null
    persistId?: number
  }): Promise<void> {
    setChecking(args.persistId ?? 'form')
    try {
      const res = await window.electronAPI.proxy.check(args)
      if (args.persistId) {
        await reload()
      } else {
        setFormCheck(res)
      }
    } finally {
      setChecking(null)
    }
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    const p = Number.parseInt(port, 10)
    const res: CreateProxyResult = await window.electronAPI.db.createProxy({
      name: name.trim() || null,
      host: host.trim(),
      port: p,
      login: login.trim() || null,
      password: password || null
    })
    if (!res.ok) {
      setError(res.error)
      return
    }
    setName('')
    setHost('')
    setPort('1080')
    setLogin('')
    setPassword('')
    setFormCheck(null)
    await reload()
  }

  function onHostChange(value: string): void {
    setHost(value)
    const parsed = parseCompactProxyLine(value)
    if (!parsed) return
    setHost(parsed.host)
    setPort(parsed.port)
    setLogin(parsed.login)
    setPassword(parsed.password)
  }

  async function onBulkSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBulkError(null)
    setBulkResult(null)
    setChecking('bulk')
    try {
      const res: CreateBulkProxyResult = await window.electronAPI.db.createBulkProxies({
        lines: bulkLines,
        defaultNamePrefix: bulkNamePrefix.trim() || 'Proxy'
      })
      if (!res.ok) {
        setBulkError(res.error)
        return
      }
      const lines = [`Добавлено: ${res.data.created}/${res.data.total}`]
      if (res.data.failed > 0) {
        lines.push(`Ошибок: ${res.data.failed}`)
        lines.push(...res.data.errors.slice(0, 5))
        if (res.data.errors.length > 5) lines.push(`...ещё ${res.data.errors.length - 5}`)
      }
      setBulkResult(lines.join('\n'))
      await reload()
    } finally {
      setChecking(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="border border-industrial-border bg-industrial-panel p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-industrial-text">SOCKS5-прокси</div>
            <p className="mt-1 text-xs text-industrial-dim">
              Поддерживается только <span className="text-industrial-text">SOCKS5</span> (логин и пароль
              опциональны). Host и порт должны быть уникальны.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowCreateForm((v) => !v)}
            className="border border-industrial-border bg-industrial-bg px-3 py-2 text-xs text-industrial-text hover:border-industrial-muted"
          >
            {showCreateForm ? 'Скрыть форму' : 'Добавить прокси'}
          </button>
        </div>
        {showCreateForm ? (
          <>
            <div className="mt-3 flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setMode('single')}
                className={`border px-2 py-1 ${
                  mode === 'single'
                    ? 'border-industrial-border bg-industrial-raised text-industrial-text'
                    : 'border-industrial-border bg-industrial-bg text-industrial-muted'
                }`}
              >
                По одному
              </button>
              <button
                type="button"
                onClick={() => setMode('bulk')}
                className={`border px-2 py-1 ${
                  mode === 'bulk'
                    ? 'border-industrial-border bg-industrial-raised text-industrial-text'
                    : 'border-industrial-border bg-industrial-bg text-industrial-muted'
                }`}
              >
                Массово
              </button>
            </div>
            {mode === 'single' ? (
          <form className="mt-3 grid max-w-xl gap-2" onSubmit={onSubmit}>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Название (необязательно)
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={name}
              onChange={(ev) => setName(ev.target.value)}
            />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
            <label className="grid gap-1 text-xs text-industrial-muted">
              Host SOCKS5
              <input
                required
                className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                value={host}
                onChange={(ev) => onHostChange(ev.target.value)}
                placeholder="127.0.0.1 или host:port:login:password"
              />
            </label>
            <label className="grid gap-1 text-xs text-industrial-muted">
              Порт
              <input
                required
                className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                value={port}
                onChange={(ev) => setPort(ev.target.value)}
                inputMode="numeric"
              />
            </label>
          </div>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Логин
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={login}
              onChange={(ev) => setLogin(ev.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Пароль
            <input
              type="password"
              className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
            />
          </label>
          {error ? <div className="text-xs text-red-400">{error}</div> : null}
          {formCheck ? (
            <div className="border border-industrial-border bg-industrial-bg px-2 py-2 text-xs text-industrial-muted">
              {formCheck.ok ? (
                <span className="text-industrial-text">
                  Результат: <span className="font-mono">{formCheck.ip}</span> · {formCheck.country},{' '}
                  {formCheck.city}
                  {formCheck.isp ? ` · ${formCheck.isp}` : ''}
                </span>
              ) : (
                <span className="text-red-400">Не удалось: {formCheck.error}</span>
              )}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={checking === 'form'}
              onClick={() =>
                void runCheck({
                  host: host.trim(),
                  port: Number.parseInt(port, 10),
                  login: login.trim() || null,
                  password: password || null
                })
              }
              className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-bg px-3 py-2 text-sm text-industrial-text hover:border-industrial-muted disabled:opacity-50"
            >
              {checking === 'form' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Проверить (без сохранения)
            </button>
            <button
              type="submit"
              className="border border-industrial-border bg-industrial-raised px-3 py-2 text-sm text-industrial-text hover:bg-industrial-panel"
            >
              Сохранить прокси
            </button>
          </div>
          </form>
            ) : (
              <form className="mt-3 grid max-w-2xl gap-2" onSubmit={onBulkSubmit}>
            <p className="text-xs text-industrial-dim">
              Каждая строка в формате: <span className="font-mono text-industrial-text">host:port:login:password</span>
            </p>
            <label className="grid gap-1 text-xs text-industrial-muted">
              Префикс названия
              <input
                className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
                value={bulkNamePrefix}
                onChange={(ev) => setBulkNamePrefix(ev.target.value)}
                placeholder="Proxy"
              />
            </label>
            <label className="grid gap-1 text-xs text-industrial-muted">
              Прокси (по строкам)
              <textarea
                rows={8}
                className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-xs text-industrial-text outline-none focus:border-industrial-muted"
                value={bulkLines}
                onChange={(ev) => setBulkLines(ev.target.value)}
                placeholder={'193.141.92.247:64711:bWQbFnEr:SX96Jwpr\n193.141.92.248:64712:user:pass'}
              />
            </label>
            {bulkError ? <div className="text-xs text-red-400">{bulkError}</div> : null}
            {bulkResult ? (
              <pre className="whitespace-pre-wrap border border-industrial-border bg-industrial-bg px-2 py-2 text-xs text-industrial-muted">
                {bulkResult}
              </pre>
            ) : null}
            <div>
              <button
                type="submit"
                disabled={checking === 'bulk'}
                className="inline-flex items-center gap-2 border border-industrial-border bg-industrial-raised px-3 py-2 text-sm text-industrial-text hover:bg-industrial-panel disabled:opacity-50"
              >
                {checking === 'bulk' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Добавить массово
              </button>
            </div>
              </form>
            )}
          </>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto border border-industrial-border bg-industrial-panel">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-industrial-raised text-industrial-muted">
            <tr>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">ID</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Тип</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Название</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Адрес</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Логин</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Последняя проверка</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium"> </th>
            </tr>
          </thead>
          <tbody className="text-industrial-text">
            {rows.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-industrial-dim" colSpan={7}>
                  Прокси ещё не добавлены — сначала создайте запись выше.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-b border-industrial-border">
                  <td className="px-2 py-2 font-mono text-industrial-muted">{r.id}</td>
                  <td className="px-2 py-2 font-mono text-industrial-muted">{r.scheme}</td>
                  <td className="px-2 py-2">{r.name ?? '—'}</td>
                  <td className="px-2 py-2 font-mono">
                    {r.host}:{r.port}
                  </td>
                  <td className="px-2 py-2 text-industrial-muted">{r.login ?? '—'}</td>
                  <td className="max-w-[280px] px-2 py-2 text-industrial-dim">{formatLastCheck(r.last_check_status)}</td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      disabled={checking === r.id}
                      onClick={() => void runCheck({ persistId: r.id })}
                      className="inline-flex items-center gap-1 border border-industrial-border bg-industrial-bg px-2 py-1 text-[11px] text-industrial-text hover:border-industrial-muted disabled:opacity-50"
                    >
                      {checking === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Проверить
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
