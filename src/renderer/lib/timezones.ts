/**
 * IANA timezones for channel scheduling UI (stored as-is in DB).
 * Curated for RU/CIS + common global hubs; unknown zones still work via fallback option in UI.
 */
export const SCHEDULE_TIMEZONE_IANA: readonly string[] = [
  'Pacific/Honolulu',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Caracas',
  'America/Sao_Paulo',
  'Atlantic/Azores',
  'UTC',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/Warsaw',
  'Europe/Kiev',
  'Europe/Kaliningrad',
  'Europe/Moscow',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Krasnoyarsk',
  'Asia/Novosibirsk',
  'Asia/Irkutsk',
  'Asia/Yakutsk',
  'Asia/Vladivostok',
  'Asia/Magadan',
  'Asia/Kamchatka',
  'Asia/Tbilisi',
  'Asia/Yerevan',
  'Asia/Baku',
  'Asia/Tashkent',
  'Asia/Almaty',
  'Asia/Dubai',
  'Asia/Tehran',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Seoul',
  'Asia/Tokyo',
  'Australia/Perth',
  'Australia/Sydney',
  'Pacific/Auckland'
]

function parseLongOffsetToMinutes(part: string | undefined): number | null {
  if (!part) return null
  const normalized = part.replace(/\u2212/g, '-').trim()
  const m = normalized.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  const h = Number(m[2])
  const min = Number(m[3] ?? '0')
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null
  return sign * (h * 60 + min)
}

/** e.g. "UTC+03:00" for label next to city name */
export function utcOffsetLabelForIANA(timeZone: string, when: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset'
    })
      .formatToParts(when)
      .find((p) => p.type === 'timeZoneName')?.value
    const parsed = parseLongOffsetToMinutes(part)
    if (parsed === null) return ''
    const sign = parsed >= 0 ? '+' : '-'
    const abs = Math.abs(parsed)
    const hh = String(Math.floor(abs / 60)).padStart(2, '0')
    const mm = String(abs % 60).padStart(2, '0')
    return `UTC${sign}${hh}:${mm}`
  } catch {
    return ''
  }
}

export function offsetSortKeyForIANA(timeZone: string, when: Date = new Date()): number {
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset'
    })
      .formatToParts(when)
      .find((p) => p.type === 'timeZoneName')?.value
    return parseLongOffsetToMinutes(part) ?? 0
  } catch {
    return 0
  }
}

export function timezoneSelectLabel(timeZone: string, when: Date = new Date()): string {
  const off = utcOffsetLabelForIANA(timeZone, when)
  const city = timeZone.split('/').pop()?.replace(/_/g, ' ') ?? timeZone
  return off ? `${city} (${off})` : city
}

export function sortedScheduleTimezones(when: Date = new Date()): string[] {
  return [...SCHEDULE_TIMEZONE_IANA].sort((a, b) => {
    const da = offsetSortKeyForIANA(a, when)
    const db = offsetSortKeyForIANA(b, when)
    if (da !== db) return da - db
    return a.localeCompare(b)
  })
}

export function isListedScheduleTimezone(timeZone: string): boolean {
  return (SCHEDULE_TIMEZONE_IANA as readonly string[]).includes(timeZone)
}
