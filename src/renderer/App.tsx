import {
  LayoutDashboard,
  ListVideo,
  Radio,
  ScrollText,
  Server,
  Settings,
  Video
} from 'lucide-react'
import { useEffect, useState } from 'react'
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
  { id: 'proxies', label: 'Прокси', icon: Server, subtitle: 'Только SOCKS5 · проверка IP и гео' },
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

  useEffect(() => {
    void window.electronAPI.bootstrap().finally(() => setReady(true))
  }, [])

  const current = nav.find((n) => n.id === active) ?? nav[0]
  const ActiveIcon = current.icon

  return (
    <div className="flex h-full min-h-0 border border-industrial-border bg-industrial-bg">
      <aside className="flex w-52 shrink-0 flex-col border-r border-industrial-border bg-industrial-panel">
        <div className="border-b border-industrial-border px-3 py-3">
          <div className="text-xs uppercase tracking-wide text-industrial-muted">YouTube</div>
          <div className="text-sm font-semibold text-industrial-text">Automation OS</div>
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
                <span>{item.label}</span>
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
