import { Check, Copy } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

type OAuthListItem = Awaited<ReturnType<typeof window.electronAPI.db.listOAuthProfiles>>[number]
type CreateOAuthResult = Awaited<ReturnType<typeof window.electronAPI.db.createOAuthProfile>>
type DeleteOAuthResult = Awaited<ReturnType<typeof window.electronAPI.db.deleteOAuthProfile>>

function CopyableUrl({ href }: { href: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* ignore */
    }
  }
  return (
    <span className="inline-flex max-w-full items-start gap-1.5 align-top">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 break-all font-mono text-[11px] text-industrial-text underline decoration-industrial-border underline-offset-2 hover:decoration-industrial-text"
      >
        {href}
      </a>
      <button
        type="button"
        onClick={() => void onCopy()}
        title={copied ? 'Скопировано' : 'Скопировать ссылку'}
        className="mt-0.5 shrink-0 rounded border border-industrial-border bg-industrial-bg p-1 text-industrial-muted hover:border-industrial-muted hover:text-industrial-text"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2} aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        )}
      </button>
    </span>
  )
}

export function SettingsPage(): JSX.Element {
  const [telegram_bot_token, setTelegramBotToken] = useState('')
  const [telegram_chat_id, setTelegramChatId] = useState('')
  const [adspower_api_base_url, setAdsPowerApiBaseUrl] = useState('http://local.adspower.net:50325')
  const [adspower_api_key, setAdsPowerApiKey] = useState('')
  const [g4f_api_base_url, setG4fApiBaseUrl] = useState('http://127.0.0.1:1337/v1')
  const [g4f_model, setG4fModel] = useState('gpt-4o-mini')
  const [g4f_api_key, setG4fApiKey] = useState('')
  const [oauthRows, setOauthRows] = useState<OAuthListItem[]>([])
  const [oauthLabel, setOauthLabel] = useState('')
  const [oauthCid, setOauthCid] = useState('')
  const [oauthSec, setOauthSec] = useState('')
  const [oauthErr, setOauthErr] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, o] = await Promise.all([window.electronAPI.settings.get(), window.electronAPI.db.listOAuthProfiles()])
      setTelegramBotToken(s.telegram_bot_token ?? '')
      setTelegramChatId(s.telegram_chat_id ?? '')
      setAdsPowerApiBaseUrl(s.adspower_api_base_url?.trim() || 'http://local.adspower.net:50325')
      setAdsPowerApiKey(s.adspower_api_key ?? '')
      setG4fApiBaseUrl(s.g4f_api_base_url?.trim() || 'http://127.0.0.1:1337/v1')
      setG4fModel(s.g4f_model?.trim() || 'gpt-4o-mini')
      setG4fApiKey(s.g4f_api_key ?? '')
      setOauthRows(o)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onSaveTelegram(): Promise<void> {
    setStatus(null)
    await window.electronAPI.settings.set({
      telegram_bot_token,
      telegram_chat_id,
      adspower_api_base_url,
      adspower_api_key,
      g4f_api_base_url,
      g4f_model,
      g4f_api_key
    })
    setStatus('Настройки сохранены.')
  }

  async function onAddOAuthProfile(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setOauthErr(null)
    const res: CreateOAuthResult = await window.electronAPI.db.createOAuthProfile({
      label: oauthLabel,
      google_client_id: oauthCid,
      google_client_secret: oauthSec
    })
    if (!res.ok) {
      setOauthErr(res.error)
      return
    }
    setOauthLabel('')
    setOauthCid('')
    setOauthSec('')
    await load()
  }

  async function onDeleteOAuthProfile(id: number): Promise<void> {
    setOauthErr(null)
    const res: DeleteOAuthResult = await window.electronAPI.db.deleteOAuthProfile(id)
    if (!res.ok) {
      setOauthErr(res.error)
      return
    }
    await load()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="border border-industrial-border bg-industrial-panel p-4">
        <div className="text-sm font-medium text-industrial-text">OAuth-Профили</div>
        <p className="mt-1 text-xs text-industrial-dim">
          Каждая строка в таблице — отдельная пара Client ID / Client Secret из своего проекта Google Cloud. Секрет
          хранится только локально в SQLite. На один профиль можно повесить до 10 каналов в этом приложении.
        </p>

        <div className="mt-4 overflow-auto border border-industrial-border bg-industrial-bg">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-industrial-raised text-industrial-muted">
              <tr>
                <th className="border-b border-industrial-border px-2 py-2 font-medium">ID</th>
                <th className="border-b border-industrial-border px-2 py-2 font-medium">Название</th>
                <th className="border-b border-industrial-border px-2 py-2 font-medium">Client ID</th>
                <th className="border-b border-industrial-border px-2 py-2 font-medium">Каналов</th>
                <th className="border-b border-industrial-border px-2 py-2 font-medium"> </th>
              </tr>
            </thead>
            <tbody className="text-industrial-text">
              {oauthRows.length === 0 ? (
                <tr>
                  <td className="px-2 py-3 text-industrial-dim" colSpan={5}>
                    Профилей пока нет — добавьте первый через форму ниже.
                  </td>
                </tr>
              ) : (
                oauthRows.map((r) => (
                  <tr key={r.id} className="border-b border-industrial-border">
                    <td className="px-2 py-2 font-mono text-industrial-muted">{r.id}</td>
                    <td className="px-2 py-2">{r.label}</td>
                    <td className="max-w-[200px] truncate px-2 py-2 font-mono text-industrial-dim">{r.google_client_id}</td>
                    <td className="px-2 py-2">
                      {r.channel_count}/10
                    </td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        onClick={() => void onDeleteOAuthProfile(r.id)}
                        disabled={r.channel_count > 0}
                        className="border border-industrial-border bg-industrial-panel px-2 py-1 text-[11px] text-industrial-text hover:bg-industrial-bg disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <form className="mt-4 grid max-w-2xl gap-2" onSubmit={(ev) => void onAddOAuthProfile(ev)}>
          <div className="text-xs font-medium text-industrial-text">Новый профиль</div>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Название (например: GCP проект «Alpha»)
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={oauthLabel}
              onChange={(ev) => setOauthLabel(ev.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Client ID
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={oauthCid}
              onChange={(ev) => setOauthCid(ev.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Client Secret
            <input
              type="password"
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={oauthSec}
              onChange={(ev) => setOauthSec(ev.target.value)}
              autoComplete="off"
            />
          </label>
          {oauthErr ? <div className="text-xs text-red-400">{oauthErr}</div> : null}
          <button
            type="submit"
            disabled={loading}
            className="w-fit border border-industrial-border bg-industrial-raised px-3 py-2 text-sm text-industrial-text hover:bg-industrial-panel disabled:opacity-50"
          >
            Добавить OAuth-профиль
          </button>
        </form>
      </div>

      <div className="border border-industrial-border bg-industrial-panel p-4">
        <div className="text-sm font-medium text-industrial-text">Google Cloud — настройка OAuth</div>
        <p className="mt-1 text-xs text-industrial-dim">
          Один такой проход на каждый OAuth-профиль в таблице выше. Потом в приложении привязывайте каналы к этому
          профилю и добавляйте тестовых пользователей (п. 9) под каждую почту канала.
        </p>

        <ol className="mt-4 list-decimal space-y-4 pl-5 text-xs text-industrial-muted">
          <li className="pl-1">
            <span className="text-industrial-text">Консоль.</span> Откройте Google Cloud Console (при запросе можно
            выбрать любую страну/регион).
            <div className="mt-1">
              <CopyableUrl href="https://console.cloud.google.com/" />
            </div>
          </li>
          <li className="pl-1">
            <span className="text-industrial-text">Новый проект.</span> Сверху слева «Select a project» → «New
            Project», укажите любое имя и создайте проект.
            <div className="mt-1">
              <CopyableUrl href="https://console.cloud.google.com/projectcreate" />
            </div>
          </li>
          <li className="pl-1">
            <span className="text-industrial-text">Экран согласия (OAuth consent).</span> Перейдите по ссылке →
            «Get started».
            <ul className="mt-2 list-disc space-y-1 pl-4">
              <li>
                Шаг 1: любое имя приложения.
              </li>
              <li>
                Шаг 2: тип <span className="text-industrial-text">External</span>.
              </li>
              <li>
                Шаг 3: укажите email той учётной записи Google, с которой создаёте проект (контакт разработчика).
              </li>
              <li>
                Далее <span className="text-industrial-text">Finish</span> и при необходимости{' '}
                <span className="text-industrial-text">Create</span>.
              </li>
            </ul>
            <div className="mt-2">
              <CopyableUrl href="https://console.cloud.google.com/auth/overview" />
            </div>
          </li>
          <li className="pl-1">
            <span className="text-industrial-text">Создать OAuth-клиент.</span> На экране обзора (после шага 3) в блоке
            «Metrics» справа нажмите «Create OAuth client». Если кнопки нет — тот же раздел через «Clients».
            <div className="mt-2">
              <CopyableUrl href="https://console.cloud.google.com/auth/overview" />
            </div>
          </li>
          <li className="pl-1">
            <span className="text-industrial-text">Тип Desktop.</span> В «Application type» выберите{' '}
            <span className="text-industrial-text">Desktop app</span>, имя можно не менять → OK.
            <div className="mt-2">
              <CopyableUrl href="https://console.cloud.google.com/auth/clients" />
            </div>
          </li>
          <li className="pl-1">
            <span className="text-industrial-text">Client ID и Secret в программу.</span> Откройте созданное
            приложение (синее имя в списке), скопируйте <span className="text-industrial-text">Client ID</span> и{' '}
            <span className="text-industrial-text">Client secret</span> и вставьте в форму «Новый профиль» выше.
            <div className="mt-2">
              <CopyableUrl href="https://console.cloud.google.com/auth/clients" />
            </div>
          </li>
          <li className="pl-1">
            <span className="text-industrial-text">YouTube Data API v3.</span> Включите API кнопкой Enable.
            <div className="mt-1">
              <CopyableUrl href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" />
            </div>
          </li>
          <li className="pl-1">
            <span className="text-industrial-text">Области (scopes).</span> Откройте раздел scopes → «Add or remove
            scopes» → отметьте все пункты, где фигурирует <span className="text-industrial-text">YouTube Data API v3</span>
            . Ниже нажмите <span className="text-industrial-text">Update</span>, затем ещё ниже{' '}
            <span className="text-industrial-text">Save</span>.
            <div className="mt-2">
              <CopyableUrl href="https://console.cloud.google.com/auth/scopes" />
            </div>
          </li>
          <li className="pl-1">
            <span className="text-industrial-text">Тестовые пользователи.</span> Раздел Audience → «Test users» → «+
            Add users». Сюда нужно добавлять <span className="text-industrial-text">каждую почту Google-аккаунта</span>
            , с которой будете подключать канал к этому OAuth-приложению (пока приложение в режиме тестирования).
            <div className="mt-2">
              <CopyableUrl href="https://console.cloud.google.com/auth/audience" />
            </div>
          </li>
        </ol>
      </div>

      <div className="border border-industrial-border bg-industrial-panel p-4">
        <div className="text-sm font-medium text-industrial-text">ADS Power Local API</div>
        <div className="mt-4 grid max-w-2xl gap-3">
          <label className="grid gap-1 text-xs text-industrial-muted">
            Base URL (локальный API)
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={adspower_api_base_url}
              onChange={(ev) => setAdsPowerApiBaseUrl(ev.target.value)}
              placeholder="http://local.adspower.net:50325"
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            API Key (Bearer token)
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={adspower_api_key}
              onChange={(ev) => setAdsPowerApiKey(ev.target.value)}
              autoComplete="off"
            />
          </label>
        </div>
      </div>

      <div className="border border-industrial-border bg-industrial-panel p-4">
        <div className="text-sm font-medium text-industrial-text">AI генерация (g4f / OpenAI-compatible)</div>
        <div className="mt-4 grid max-w-2xl gap-3">
          <label className="grid gap-1 text-xs text-industrial-muted">
            API Base URL
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={g4f_api_base_url}
              onChange={(ev) => setG4fApiBaseUrl(ev.target.value)}
              placeholder="http://127.0.0.1:1337/v1"
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Model
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={g4f_model}
              onChange={(ev) => setG4fModel(ev.target.value)}
              placeholder="gpt-4o-mini"
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            API Key (опционально)
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={g4f_api_key}
              onChange={(ev) => setG4fApiKey(ev.target.value)}
              autoComplete="off"
            />
          </label>
        </div>
      </div>

      <div className="border border-industrial-border bg-industrial-panel p-4">
        <div className="text-sm font-medium text-industrial-text">Telegram</div>

        <div className="mt-4 grid max-w-2xl gap-3">
          <label className="grid gap-1 text-xs text-industrial-muted">
            Токен бота (например 123456:ABC…)
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={telegram_bot_token}
              onChange={(ev) => setTelegramBotToken(ev.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            chat_id (личный чат, группа или канал)
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={telegram_chat_id}
              onChange={(ev) => setTelegramChatId(ev.target.value)}
              autoComplete="off"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onSaveTelegram()}
            disabled={loading}
            className="border border-industrial-border bg-industrial-raised px-3 py-2 text-sm text-industrial-text hover:bg-industrial-panel disabled:opacity-50"
          >
            Сохранить Telegram
          </button>
          {status ? <span className="text-xs text-industrial-muted">{status}</span> : null}
        </div>
      </div>
    </div>
  )
}
