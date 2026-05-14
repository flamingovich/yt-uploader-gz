/** Поле «8», «8:30», «08:30» → минуты от полуночи 0..1439 */
export function parseTimeHmToMins(s: string, fallbackMins: number): number {
  const t = s.trim()
  if (!t) return fallbackMins
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t)
  if (!m) return fallbackMins
  let h = Number(m[1])
  let min = m[2] !== undefined ? Number(m[2]) : 0
  if (!Number.isFinite(h) || !Number.isFinite(min)) return fallbackMins
  h = Math.max(0, Math.min(23, Math.floor(h)))
  min = Math.max(0, Math.min(59, Math.floor(min)))
  return h * 60 + min
}

/** Короткий вид для поля ввода: `8:30`, `23:00` */
export function formatTimeHmFromMins(mins: number): string {
  const m = Math.max(0, Math.min(1439, Math.floor(mins)))
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${h}:${String(mm).padStart(2, '0')}`
}
