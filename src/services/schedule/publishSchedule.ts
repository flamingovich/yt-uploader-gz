/**
 * Расчёт времён отложенной публикации: якорь по schedule_start_at (полная дата+время),
 * равномерные слоты в окне [windowStartHour, windowEndHour], джиттер ±randomizeMinutes
 * с прижатием к окну, чтобы не уезжать в 08:xx при окне с 9:00.
 */

export function clampDateToPublicationWindow(
  d: Date,
  windowStartHour: number,
  windowEndHour: number
): Date {
  const startH = Math.max(0, Math.min(23, windowStartHour))
  const endH = Math.max(startH + 1, Math.min(23, windowEndHour))
  const w0 = startH * 60
  const w1 = endH * 60 + 59
  const out = new Date(d)
  let mins = out.getHours() * 60 + out.getMinutes()
  if (mins < w0) {
    out.setHours(Math.floor(w0 / 60), w0 % 60, 0, 0)
  } else if (mins > w1) {
    out.setHours(Math.floor(w1 / 60), w1 % 60, 0, 0)
  }
  return out
}

function jitterDelta(serial: number, rnd: number, mode: 'preview' | 'upload'): number {
  const r = Math.max(0, Math.min(240, rnd))
  if (r <= 0) return 0
  if (mode === 'preview') {
    return ((serial * 37) % (r * 2 + 1)) - r
  }
  return Math.floor(Math.random() * (r * 2 + 1)) - r
}

function parseAnchorIso(baseIso: string | null): Date | null {
  if (!baseIso?.trim()) return null
  const d = new Date(baseIso.trim())
  return Number.isNaN(d.getTime()) ? null : d
}

export function collectFuturePublishCandidates(input: {
  baseIso: string | null
  videosPerDay: number
  windowStartHour: number
  windowEndHour: number
  randomizeMinutes: number
  minFuture: Date
  /** Сколько первых подходящих слотов собрать (достаточно для превью или futureSlotIndex+1). */
  needCount: number
  mode: 'preview' | 'upload'
}): Date[] {
  const startH = Math.max(0, Math.min(23, input.windowStartHour))
  const endH = Math.max(startH + 1, Math.min(23, input.windowEndHour))
  const spanMinutes = (endH - startH) * 60
  const perDay = Math.max(1, Math.min(24, input.videosPerDay))
  const slotMinutes = Math.max(1, Math.floor(spanMinutes / perDay))
  const rnd = Math.max(0, Math.min(240, input.randomizeMinutes))

  const anchor = parseAnchorIso(input.baseIso)
  const hasAnchor = anchor !== null
  const seedDay = new Date(hasAnchor ? anchor! : input.minFuture)
  seedDay.setHours(0, 0, 0, 0)

  const out: Date[] = []
  const seen = new Set<number>()
  let serial = 0
  for (let dayShift = 0; dayShift < 90 && out.length < input.needCount; dayShift += 1) {
    for (let inDay = 0; inDay < perDay && out.length < input.needCount; inDay += 1) {
      const t = new Date(seedDay)
      t.setDate(t.getDate() + dayShift)
      if (hasAnchor && dayShift === 0) {
        const anchorM = anchor!.getHours() * 60 + anchor!.getMinutes()
        const candidateMinutes = anchorM + inDay * slotMinutes
        // Не допускаем "перелив" слотов первого дня на следующий календарный день:
        // именно он порождал лишние слоты/дубли типа 09:00, 09:00, 09:12.
        if (candidateMinutes > endH * 60 + 59) break
        t.setHours(0, 0, 0, 0)
        t.setMinutes(candidateMinutes)
      } else {
        t.setHours(startH, 0, 0, 0)
        t.setMinutes(inDay * slotMinutes)
      }
      if (rnd > 0) {
        t.setMinutes(t.getMinutes() + jitterDelta(serial, rnd, input.mode))
      }
      serial += 1
      const clamped = clampDateToPublicationWindow(t, startH, endH)
      const ts = clamped.getTime()
      if (clamped >= input.minFuture && !seen.has(ts)) {
        seen.add(ts)
        out.push(clamped)
      }
    }
  }
  return out
}

export function computeScheduledPublishAtIso(input: {
  baseIso: string | null
  futureSlotIndex: number
  videosPerDay: number
  windowStartHour: number
  windowEndHour: number
  randomizeMinutes: number
  now?: Date
}): string {
  const now = input.now ?? new Date()
  const minFuture = new Date(now.getTime() + 60_000)
  const need = Math.max(1, input.futureSlotIndex + 1)
  const candidates = collectFuturePublishCandidates({
    baseIso: input.baseIso,
    videosPerDay: input.videosPerDay,
    windowStartHour: input.windowStartHour,
    windowEndHour: input.windowEndHour,
    randomizeMinutes: input.randomizeMinutes,
    minFuture,
    needCount: need,
    mode: 'upload'
  })
  const chosen =
    candidates[input.futureSlotIndex] ?? new Date(minFuture.getTime() + input.futureSlotIndex * 3_600_000)
  return chosen.toISOString()
}
