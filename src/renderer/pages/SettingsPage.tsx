import { useCallback, useEffect, useState } from 'react'

const LINK = (href: string, label: string) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="text-industrial-text underline decoration-industrial-border underline-offset-2 hover:decoration-industrial-text"
  >
    {label}
  </a>
)

type OAuthListItem = Awaited<ReturnType<typeof window.electronAPI.db.listOAuthProfiles>>[number]
type CreateOAuthResult = Awaited<ReturnType<typeof window.electronAPI.db.createOAuthProfile>>
type DeleteOAuthResult = Awaited<ReturnType<typeof window.electronAPI.db.deleteOAuthProfile>>

export function SettingsPage(): JSX.Element {
  const [telegram_bot_token, setTelegramBotToken] = useState('')
  const [telegram_chat_id, setTelegramChatId] = useState('')
  const [google_oauth_client_id, setGoogleClientId] = useState('')
  const [google_oauth_client_secret, setGoogleClientSecret] = useState('')
  const [upload_cooldown_seconds, setUploadCooldownSeconds] = useState('20')
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
      setGoogleClientId(s.google_oauth_client_id ?? '')
      setGoogleClientSecret(s.google_oauth_client_secret ?? '')
      setUploadCooldownSeconds(s.upload_cooldown_seconds ?? '20')
      setOauthRows(o)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onSaveTelegramAndCooldown(): Promise<void> {
    setStatus(null)
    await window.electronAPI.settings.set({
      telegram_bot_token,
      telegram_chat_id,
      upload_cooldown_seconds
    })
    setStatus('Telegram и пауза между загрузками сохранены.')
  }

  async function onSaveLegacyOAuth(): Promise<void> {
    setStatus(null)
    await window.electronAPI.settings.set({
      google_oauth_client_id,
      google_oauth_client_secret
    })
    setStatus('Legacy OAuth сохранен. Пустые значения не перезаписывают существующие ключи.')
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
        <div className="text-sm font-medium text-industrial-text">Что нужно заполнить</div>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-industrial-muted">
          <li>
            <span className="text-industrial-text">Telegram</span> — токен бота и chat_id для логов и статусов.
          </li>
          <li>
            <span className="text-industrial-text">OAuth-профили</span> — по одному на каждый Google Cloud-проект
            (Desktop OAuth client). На один профиль в этом приложении можно повесить до{' '}
            <span className="text-industrial-text">10 каналов</span> (изоляция риска по API-проекту). Для 50 каналов —
            например 5 профилей.
          </li>
          <li>
            <span className="text-industrial-text">Устаревший вариант</span> — один Client ID/Secret в блоке ниже
            (app_settings); для новых схем используйте таблицу профилей.
          </li>
        </ul>
      </div>

      <div className="border border-industrial-border bg-industrial-panel p-4">
        <div className="text-sm font-medium text-industrial-text">OAuth-профили (рекомендуется)</div>
        <p className="mt-1 text-xs text-industrial-dim">
          Каждая строка — отдельная пара Client ID / Secret из своего Cloud-проекта. Client Secret хранится в SQLite
          только локально.
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
        <div className="text-sm font-medium text-industrial-text">Telegram и устаревший единый OAuth</div>
        <p className="mt-1 text-xs text-industrial-dim">
          Поля Google ниже — для обратной совместимости. Новые интеграции лучше вешать на OAuth-профили из блока выше.
        </p>

        <div className="mt-4 grid max-w-2xl gap-3">
          <label className="grid gap-1 text-xs text-industrial-muted">
            Telegram: токен бота (например 123456:ABC…)
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={telegram_bot_token}
              onChange={(ev) => setTelegramBotToken(ev.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Telegram: chat_id (личный чат, группа или канал)
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={telegram_chat_id}
              onChange={(ev) => setTelegramChatId(ev.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Google OAuth Client ID (Desktop), единый — app_settings
            <input
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={google_oauth_client_id}
              onChange={(ev) => setGoogleClientId(ev.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Google OAuth Client Secret — app_settings
            <input
              type="password"
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={google_oauth_client_secret}
              onChange={(ev) => setGoogleClientSecret(ev.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1 text-xs text-industrial-muted">
            Пауза между загрузками (секунды)
            <input
              type="number"
              min={0}
              max={3600}
              className="border border-industrial-border bg-industrial-bg px-2 py-2 font-mono text-sm text-industrial-text outline-none focus:border-industrial-muted"
              value={upload_cooldown_seconds}
              onChange={(ev) => setUploadCooldownSeconds(ev.target.value)}
              onWheel={(ev) => (ev.currentTarget as HTMLInputElement).blur()}
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onSaveTelegramAndCooldown()}
            disabled={loading}
            className="border border-industrial-border bg-industrial-raised px-3 py-2 text-sm text-industrial-text hover:bg-industrial-panel disabled:opacity-50"
          >
            Сохранить Telegram + КД
          </button>
          <button
            type="button"
            onClick={() => void onSaveLegacyOAuth()}
            disabled={loading}
            className="border border-industrial-border bg-industrial-raised px-3 py-2 text-sm text-industrial-text hover:bg-industrial-panel disabled:opacity-50"
          >
            Сохранить legacy OAuth
          </button>
          {status ? <span className="text-xs text-industrial-muted">{status}</span> : null}
        </div>
      </div>

      <div className="border border-industrial-border bg-industrial-panel p-4">
        <div className="text-sm font-medium text-industrial-text">Google Cloud Console — пошагово</div>
        <p className="mt-1 text-xs text-industrial-dim">
          Повторите для каждого нового Cloud-проекта: свой OAuth Desktop client → новая строка в «OAuth-профили».
        </p>

        <ol className="mt-4 list-decimal space-y-3 pl-5 text-xs text-industrial-muted">
          <li>
            Откройте {LINK('https://console.cloud.google.com/', 'Google Cloud Console')} и выберите проект или
            создайте новый: {LINK('https://console.cloud.google.com/projectcreate', 'Создать проект')}.
          </li>
          <li>
            Включите API: {LINK('https://console.cloud.google.com/apis/library/youtube.googleapis.com', 'YouTube Data API v3')}{' '}
            → <span className="text-industrial-text">Enable</span>.
          </li>
          <li>
            Настройте экран согласия OAuth:{' '}
            {LINK('https://console.cloud.google.com/apis/credentials/consent', 'APIs & Services → OAuth consent screen')}.
            Тип обычно <span className="text-industrial-text">External</span>.
          </li>
          <li>
            Scopes:{' '}
            {LINK('https://developers.google.com/youtube/v3/guides/auth/installed-apps', 'YouTube: installed app')},{' '}
            {LINK('https://developers.google.com/identity/protocols/oauth2/scopes#youtube', 'Scopes for YouTube')}.
            Для загрузки видео достаточно{' '}
            <code className="text-industrial-text">youtube.upload</code>; для эфиров и метаданных Live в приложении
            запрашивается полный{' '}
            <code className="text-industrial-text">https://www.googleapis.com/auth/youtube</code> (и force-ssl) —
            добавьте эти области в экран согласия, иначе будет 403 insufficient scopes.
          </li>
          <li>
            Учётные данные:{' '}
            {LINK('https://console.cloud.google.com/apis/credentials', 'APIs & Services → Credentials')} →{' '}
            <span className="text-industrial-text">OAuth client ID</span> → тип{' '}
            <span className="text-industrial-text">Desktop app</span>. Вставьте пару в новый OAuth-профиль здесь.
          </li>
          <li>
            {LINK('https://developers.google.com/identity/protocols/oauth2/native-app', 'OAuth 2.0 for Native Apps')},{' '}
            {LINK('https://developers.google.com/identity/protocols/oauth2', 'Using OAuth 2.0 to Access Google APIs')}.
          </li>
          <li>
            {LINK('https://developers.google.com/youtube/v3/guides/uploading_a_video', 'Uploading a video')}.
          </li>
        </ol>

        <p className="mt-4 text-xs text-industrial-dim">
          Дальше в приложении: окно входа Google → authorization code → refresh_token на канал, с привязкой к{' '}
          <span className="text-industrial-text">oauth_profile_id</span> этого канала (реализация OAuth в коде —
          следующий этап).
        </p>
      </div>
    </div>
  )
}
