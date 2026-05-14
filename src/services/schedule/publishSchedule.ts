/**
 * Расчёт времён отложенной публикации: якорь по schedule_start_at (полная дата+время),
 * равномерные слоты в окне [windowStartMins, windowEndMins] (минуты от полуночи, конец включительно),
 * джиттер ±randomizeMinutes с прижатием к окну.
 */

export function clampDateToPublicationWindow(
  d: Date,
  windowStartMins: number,
  windowEndMins: number
): Date {
  const w0 = Math.max(0, Math.min(1439, Math.floor(windowStartMins)))
  const w1 = Math.max(w0, Math.min(1439, Math.floor(windowEndMins)))
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

function setTimeFromMinsOnDate(t: Date, minsFromMidnight: number): void {
  const m = Math.max(0, Math.min(1439, Math.floor(minsFromMidnight)))
  t.setHours(0, 0, 0, 0)
  t.setHours(Math.floor(m / 60), m % 60, 0, 0)
}

export function collectFuturePublishCandidates(input: {
  baseIso: string | null
  videosPerDay: number
  windowStartMins: number
  windowEndMins: number
  randomizeMinutes: number
  minFuture: Date
  /** Сколько первых подходящих слотов собрать (достаточно для превью или futureSlotIndex+1). */
  needCount: number
  mode: 'preview' | 'upload'
}): Date[] {
  let w0 = Math.max(0, Math.min(1439, Math.floor(input.windowStartMins)))
  let w1 = Math.max(0, Math.min(1439, Math.floor(input.windowEndMins)))
  if (w1 <= w0) {
    w1 = Math.min(1439, w0 + 59)
  }
  const spanMinutes = Math.max(1, w1 - w0)
  const perDay = Math.max(1, Math.min(24, input.videosPerDay))
  const slotMinutes = Math.max(1, Math.floor(spanMinutes / perDay))
  const rnd = Math.max(0, Math.min(240, input.randomizeMinutes))

  const anchor = parseAnchorIso(input.baseIso)
  const hasAnchor = anchor !== null
  const anchorTs = hasAnchor ? anchor!.getTime() : Number.NEGATIVE_INFINITY
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
        if (candidateMinutes > w1) break
        setTimeFromMinsOnDate(t, candidateMinutes)
      } else {
        const baseM = w0 + inDay * slotMinutes
        setTimeFromMinsOnDate(t, baseM)
      }
      if (rnd > 0) {
        t.setMinutes(t.getMinutes() + jitterDelta(serial, rnd, input.mode))
      }
      serial += 1
      const clamped = clampDateToPublicationWindow(t, w0, w1)
      // При якоре от очереди начинаем строго ПОСЛЕ него, чтобы не дублировать уже занятый слот.
      if (hasAnchor && clamped.getTime() <= anchorTs) {
        continue
      }
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
  windowStartMins: number
  windowEndMins: number
  randomizeMinutes: number
  now?: Date
}): string {
  const now = input.now ?? new Date()
  const minFuture = new Date(now.getTime() + 60_000)
  const need = Math.max(1, input.futureSlotIndex + 1)
  const candidates = collectFuturePublishCandidates({
    baseIso: input.baseIso,
    videosPerDay: input.videosPerDay,
    windowStartMins: input.windowStartMins,
    windowEndMins: input.windowEndMins,
    randomizeMinutes: input.randomizeMinutes,
    minFuture,
    needCount: need,
    mode: 'upload'
  })
  const chosen =
    candidates[input.futureSlotIndex] ?? new Date(minFuture.getTime() + input.futureSlotIndex * 3_600_000)
  return chosen.toISOString()
}
