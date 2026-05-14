import {
  LayoutDashboard,
  ListVideo,
  Radio,
  ScrollText,
  Server,
  Settings,
  Timer,
  Video
} from 'lucide-react'
import { useEffect, useState } from 'react'
import gzteamLogo from '../../gzteam_light.png'
import { ChannelsPage } from './pages/ChannelsPage'
import { LogsPage } from './pages/LogsPage'
import { OverviewPage } from './pages/OverviewPage'
import { ProxiesPage } from './pages/ProxiesPage'
import { QueuePage } from './pages/QueuePage'
import { SettingsPage } from './pages/SettingsPage'
import { StreamersPage } from './pages/StreamersPage'

type NavId = 'overview' | 'channels' | 'streamers' | 'proxies' | 'queue' | 'logs' | 'settings'

const nav: { id: NavId; label: string; icon: typeof LayoutDashboard; subtitle: string }[] = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard, subtitle: 'Состояние и таблицы БД' },
  {
    id: 'channels',
    label: 'Каналы',
    icon: Radio,
    subtitle: ''
  },
  {
    id: 'streamers',
    label: 'Стримы',
    icon: Video,
    subtitle: 'RTMP, прокси, ffmpeg, Live API'
  },
  { id: 'proxies', label: 'Прокси', icon: Server, subtitle: '' },
  { id: 'queue', label: 'Очередь', icon: ListVideo, subtitle: 'Загрузки и статусы' },
  { id: 'logs', label: 'Журнал', icon: ScrollText, subtitle: 'События и Telegram' },
  {
    id: 'settings',
    label: 'OAuth-Профили',
    icon: Settings,
    subtitle: 'OAuth в Google Cloud · Telegram'
  }
]

function renderBody(active: NavId): JSX.Element {
  switch (active) {
    case 'overview':
      return <OverviewPage />
    case 'channels':
      return <ChannelsPage />
    case 'streamers':
      return <StreamersPage />
    case 'proxies':
      return <ProxiesPage />
    case 'queue':
      return <QueuePage />
    case 'logs':
      return <LogsPage />
    case 'settings':
      return <SettingsPage />
    default:
      return <OverviewPage />
  }
}

export function App(): JSX.Element {
  const [active, setActive] = useState<NavId>('overview')
  const [ready, setReady] = useState(false)
  const [oauthStartupRunning, setOauthStartupRunning] = useState(false)

  useEffect(() => {
    const off = window.electronAPI.onOAuthStartupCheck((payload) => {
      if (payload.phase === 'start') setOauthStartupRunning(true)
      if (payload.phase === 'end') setOauthStartupRunning(false)
    })
    void window.electronAPI.bootstrap().finally(() => setReady(true))
    return () => {
      off()
    }
  }, [])

  const current = nav.find((n) => n.id === active) ?? nav[0]
  const ActiveIcon = current.icon

  return (
    <div className="flex h-full min-h-0 border border-industrial-border bg-industrial-bg">
      <aside className="flex w-52 shrink-0 flex-col border-r border-industrial-border bg-industrial-panel">
        <div className="border-b border-industrial-border px-3 py-3">
          <div className="flex items-center gap-2">
            <img src={gzteamLogo} alt="GZTeam" className="h-14 w-14 shrink-0 object-contain" />
            <div>
              <div className="text-xs uppercase tracking-wide text-industrial-muted">YouTube</div>
              <div className="text-sm font-semibold text-industrial-text">Automation OS</div>
            </div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0 p-2">
          {nav.map((item) => {
            const Icon = item.icon
            const isOn = active === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActive(item.id)}
                className={[
                  'flex items-center gap-2 border px-2 py-2 text-left text-sm',
                  'border-transparent',
                  isOn
                    ? 'border-industrial-border bg-industrial-raised text-industrial-text'
                    : 'text-industrial-muted hover:border-industrial-border hover:bg-industrial-bg hover:text-industrial-text'
                ].join(' ')}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <span className="truncate">{item.label}</span>
                  {item.id === 'channels' && oauthStartupRunning ? (
                    <span className="inline-flex shrink-0" title="Проверка OAuth у каналов…">
                      <Timer
                        className="h-3.5 w-3.5 text-industrial-dim animate-pulse"
                        strokeWidth={1.5}
                        aria-hidden
                      />
                    </span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </nav>
        <div className="border-t border-industrial-border px-3 py-2 text-xs text-industrial-dim">
          {ready ? 'Связь с main: OK' : 'Инициализация…'}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-industrial-border bg-industrial-panel px-4 py-3">
          <ActiveIcon className="h-5 w-5 text-industrial-muted" strokeWidth={1.5} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-industrial-text">{current.label}</div>
            <div className="text-xs text-industrial-dim">{current.subtitle}</div>
          </div>
        </header>

        <section className="flex flex-1 flex-col overflow-auto p-4">{renderBody(active)}</section>
      </main>
    </div>
  )
}
