import { useCallback, useEffect, useState } from 'react'

type Channel = Awaited<ReturnType<typeof window.electronAPI.db.listChannels>>[number]
type QueueItem = Awaited<ReturnType<typeof window.electronAPI.db.listQueue>>[number]
type LogItem = Awaited<ReturnType<typeof window.electronAPI.db.listLogs>>[number]

export function OverviewPage(): JSX.Element {
  const [channels, setChannels] = useState<Channel[]>([])
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [logs, setLogs] = useState<LogItem[]>([])

  const reload = useCallback(async () => {
    const [c, q, l] = await Promise.all([
      window.electronAPI.db.listChannels(),
      window.electronAPI.db.listQueue(300),
      window.electronAPI.db.listLogs(50)
    ])
    setChannels(c)
    setQueue(q)
    setLogs(l)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const connected = channels.filter((x) => Boolean(x.youtube_channel_id)).length
  const pending = queue.filter((x) => ['pending', 'scheduling', 'scheduled', 'uploading', 'processing'].includes(x.status)).length
  const failed = queue.filter((x) => x.status === 'failed').length
  const completed = queue.filter((x) => x.status === 'completed').length
  const lastLog = logs[0]

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="border border-industrial-border bg-industrial-panel p-3">
          <div className="text-xs text-industrial-dim">Каналов</div>
          <div className="mt-1 text-xl text-industrial-text">{channels.length}</div>
          <div className="text-xs text-industrial-muted">Подключено к YouTube: {connected}</div>
        </div>
        <div className="border border-industrial-border bg-industrial-panel p-3">
          <div className="text-xs text-industrial-dim">Очередь активна</div>
          <div className="mt-1 text-xl text-yellow-300">{pending}</div>
          <div className="text-xs text-industrial-muted">pending/scheduled/uploading</div>
        </div>
        <div className="border border-industrial-border bg-industrial-panel p-3">
          <div className="text-xs text-industrial-dim">Успешно</div>
          <div className="mt-1 text-xl text-emerald-400">{completed}</div>
          <div className="text-xs text-industrial-muted">completed</div>
        </div>
        <div className="border border-industrial-border bg-industrial-panel p-3">
          <div className="text-xs text-industrial-dim">Ошибки</div>
          <div className="mt-1 text-xl text-red-400">{failed}</div>
          <div className="text-xs text-industrial-muted">failed</div>
        </div>
      </div>

      <div className="border border-industrial-border bg-industrial-panel p-4">
        <div className="text-sm text-industrial-text">Последнее событие</div>
        <div className="mt-2 text-xs text-industrial-dim">
          {lastLog
            ? `${lastLog.created_at} · ${lastLog.channel_name ?? (lastLog.channel_id != null ? `#${lastLog.channel_id}` : '—')} · ${lastLog.action_type}`
            : 'Пока нет логов'}
        </div>
        <div className="mt-1 text-xs text-industrial-text">{lastLog?.message ?? ''}</div>
      </div>
    </div>
  )
}
