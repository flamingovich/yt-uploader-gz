import { useCallback, useEffect, useState } from 'react'

type QueueRow = Awaited<ReturnType<typeof window.electronAPI.db.listQueue>>[number]

function fmt(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function statusClass(status: QueueRow['status']): string {
  if (status === 'completed') return 'text-emerald-400'
  if (status === 'failed' || status === 'cancelled') return 'text-red-400'
  if (status === 'uploading' || status === 'processing') return 'text-yellow-300'
  return 'text-industrial-text'
}

export function QueuePage(): JSX.Element {
  const [rows, setRows] = useState<QueueRow[]>([])
  const [loading, setLoading] = useState(false)
  const [limit, setLimit] = useState(200)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const q = await window.electronAPI.db.listQueue(limit)
      setRows(q)
    } finally {
      setLoading(false)
    }
  }, [limit])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between border border-industrial-border bg-industrial-panel px-3 py-2 text-xs">
        <div className="text-industrial-dim">Очередь upload_queue. Показано: {rows.length}</div>
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
              <th className="border-b border-industrial-border px-2 py-2 font-medium">ID</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Канал</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Файл</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Статус</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">YouTube</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Создано</th>
              <th className="border-b border-industrial-border px-2 py-2 font-medium">Завершено</th>
            </tr>
          </thead>
          <tbody className="text-industrial-text">
            {rows.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-industrial-dim" colSpan={7}>
                  Очередь пока пуста.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-b border-industrial-border align-top">
                  <td className="px-2 py-2 font-mono text-industrial-muted">{r.id}</td>
                  <td className="px-2 py-2 text-industrial-dim">{r.channel_name ?? `#${r.channel_id}`}</td>
                  <td className="max-w-[360px] truncate px-2 py-2" title={r.file_path}>
                    {r.original_filename ?? r.file_path}
                  </td>
                  <td className={`px-2 py-2 font-medium ${statusClass(r.status)}`}>{r.status}</td>
                  <td className="px-2 py-2 font-mono text-industrial-dim">{r.youtube_video_id ?? '—'}</td>
                  <td className="px-2 py-2 font-mono text-industrial-dim">{fmt(r.created_at)}</td>
                  <td className="px-2 py-2 font-mono text-industrial-dim">{fmt(r.completed_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
