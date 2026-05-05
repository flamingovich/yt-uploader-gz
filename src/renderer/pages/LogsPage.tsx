import { useCallback, useEffect, useState } from 'react'

type LogRow = Awaited<ReturnType<typeof window.electronAPI.db.listLogs>>[number]

function levelClass(level: string): string {
  if (level === 'error') return 'text-red-400'
  if (level === 'warn') return 'text-yellow-300'
  return 'text-industrial-text'
}

const ACTION_LABELS: Record<string, string> = {
  app_started: 'Запуск приложения',
  settings_saved: 'Сохранение настроек',
  channel_created: 'Добавление канала',
  proxy_created: 'Добавление прокси',
  proxy_created_bulk: 'Массовое добавление прокси',
  proxy_check_ok: 'Проверка прокси (успех)',
  proxy_check_fail: 'Проверка прокси (ошибка)',
  youtube_oauth_connected: 'OAuth подключен',
  youtube_oauth_connected_manual: 'OAuth подключен (вручную)',
  youtube_oauth_failed: 'OAuth ошибка',
  youtube_oauth_manual_failed: 'OAuth ручной режим: ошибка',
  upload_started: 'Старт загрузки',
  upload_proxy_egress: 'Подтверждение proxy egress',
  upload_proxy_check_failed: 'Не подтвержден proxy egress',
  upload_without_proxy: 'Загрузка без прокси',
  upload_success: 'Видео загружено',
  upload_batch_finished: 'Пакет загрузки завершен',
  upload_cooldown_wait: 'Пауза между загрузками',
  upload_failed: 'Ошибка загрузки',
  oauth_profile_created: 'Создан OAuth-профиль',
  oauth_profile_deleted: 'Удален OAuth-профиль'
}

function actionLabel(actionType: string): string {
  return ACTION_LABELS[actionType] ?? actionType
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function shortFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function humanMessage(row: LogRow): string {
  const msg = row.message ?? ''
  if (row.action_type === 'upload_started') {
    const idx = msg.indexOf(':')
    const path = idx >= 0 ? msg.slice(idx + 1).trim() : msg
    return `Начали тестовую загрузку файла ${shortFileName(path)}`
  }
  if (row.action_type === 'upload_success') {
    const id = msg.split(':').pop()?.trim() ?? ''
    return id ? `YouTube принял видео. ID: ${id}` : 'YouTube принял видео.'
  }
  if (row.action_type === 'upload_proxy_egress') {
    return `Подтверждено: upload идет через прокси. ${msg.replace(/^Upload через /, '')}`
  }
  if (row.action_type === 'upload_without_proxy') {
    return 'Внимание: загрузка выполнена без прокси.'
  }
  if (row.action_type === 'upload_proxy_check_failed') {
    return `Не удалось проверить внешний IP прокси перед upload. ${msg}`
  }
  if (row.action_type === 'proxy_check_ok') {
    return `Прокси рабочий. ${msg.replace(/^Проверка SOCKS5:\s*/i, '')}`
  }
  if (row.action_type === 'proxy_check_fail') {
    return `Прокси не прошел проверку. ${msg}`
  }
  return msg
}

export function LogsPage(): JSX.Element {
  const [rows, setRows] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(false)
  const [limit, setLimit] = useState(200)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const logs = await window.electronAPI.db.listLogs(limit)
      setRows(logs)
    } finally {
      setLoading(false)
    }
  }, [limit])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onDataChanged(() => {
      void reload()
    })
    return unsubscribe
  }, [reload])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between border border-industrial-border bg-industrial-panel px-3 py-2 text-xs">
        <div className="text-industrial-dim">
          Логи действий + Telegram уведомления. Всего показано: {rows.length}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="border border-industrial-border bg-industrial-bg px-2 py-1 text-xs text-industrial-text"
          >
            <option value="100">100</option>
            <option value="200">200</option>
            <option value="500">500</option>
          </select>
          <button
            type="button"
            onClick={() => void reload()}
            className="border border-industrial-border bg-industrial-bg px-2 py-1 text-xs text-industrial-text hover:border-industrial-muted"
          >
            {loading ? 'Обновление...' : 'Обновить'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto border border-industrial-border bg-industrial-panel">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-industrial-raised text-industrial-muted">
            <tr>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Время</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Level</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Событие</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Channel</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Подробности</th>
            </tr>
          </thead>
          <tbody className="text-industrial-text">
            {rows.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-industrial-dim" colSpan={5}>
                  Логов пока нет.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-b border-industrial-border align-top">
                  <td className="whitespace-nowrap px-2 py-2 font-mono text-industrial-dim">{formatDate(r.created_at)}</td>
                  <td className={`px-2 py-2 font-medium uppercase ${levelClass(r.level)}`}>{r.level}</td>
                  <td className="px-2 py-2 text-industrial-text" title={r.action_type}>
                    {actionLabel(r.action_type)}
                  </td>
                  <td className="px-2 py-2 text-industrial-dim">{r.channel_name ?? (r.channel_id != null ? `#${r.channel_id}` : '—')}</td>
                  <td className="px-2 py-2">{humanMessage(r)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
