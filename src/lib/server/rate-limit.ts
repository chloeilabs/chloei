interface SlidingWindowRateLimitState {
  hits: number[]
  inFlight: number
  lastSeenAt: number
}

interface SlidingWindowRateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterSeconds: number | null
  resetAtEpochSeconds: number
}

interface ConcurrencySlotDecision {
  allowed: boolean
  limit: number
  inFlight: number
  retryAfterSeconds: number | null
  release: () => void
}

const slidingWindowStates = new Map<string, SlidingWindowRateLimitState>()

function pruneHitsInPlace(hits: number[], now: number, windowMs: number): void {
  while (hits.length > 0) {
    const hit = hits[0]
    if (hit === undefined || now - hit < windowMs) {
      break
    }
    hits.shift()
  }
}

function cleanupSlidingWindowStates(now: number, windowMs: number): void {
  if (slidingWindowStates.size === 0) {
    return
  }

  const staleAfterMs = Math.max(windowMs * 2, 120_000)
  for (const [identifier, state] of slidingWindowStates.entries()) {
    pruneHitsInPlace(state.hits, now, windowMs)
    if (
      state.hits.length === 0 &&
      state.inFlight === 0 &&
      now - state.lastSeenAt > staleAfterMs
    ) {
      slidingWindowStates.delete(identifier)
    }
  }
}

function getOrCreateSlidingWindowState(
  identifier: string,
  now: number
): SlidingWindowRateLimitState {
  const existing = slidingWindowStates.get(identifier)
  if (existing) {
    existing.lastSeenAt = now
    return existing
  }

  const created: SlidingWindowRateLimitState = {
    hits: [],
    inFlight: 0,
    lastSeenAt: now,
  }
  slidingWindowStates.set(identifier, created)
  return created
}

export function evaluateAndConsumeSlidingWindowRateLimit(params: {
  identifier: string
  maxRequests: number
  windowMs: number
}): SlidingWindowRateLimitDecision {
  const now = Date.now()
  cleanupSlidingWindowStates(now, params.windowMs)

  const state = getOrCreateSlidingWindowState(params.identifier, now)
  pruneHitsInPlace(state.hits, now, params.windowMs)

  const oldestHit = state.hits[0]
  const resetAtEpochSeconds =
    oldestHit === undefined
      ? Math.ceil((now + params.windowMs) / 1000)
      : Math.ceil((oldestHit + params.windowMs) / 1000)

  if (state.hits.length >= params.maxRequests) {
    const retryAfterMs =
      oldestHit === undefined
        ? params.windowMs
        : oldestHit + params.windowMs - now
    return {
      allowed: false,
      limit: params.maxRequests,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      resetAtEpochSeconds,
    }
  }

  state.hits.push(now)

  return {
    allowed: true,
    limit: params.maxRequests,
    remaining: Math.max(0, params.maxRequests - state.hits.length),
    retryAfterSeconds: null,
    resetAtEpochSeconds,
  }
}

export function tryAcquireConcurrencySlot(params: {
  identifier: string
  maxConcurrent: number
  windowMs: number
}): ConcurrencySlotDecision {
  const now = Date.now()
  cleanupSlidingWindowStates(now, params.windowMs)

  const state = getOrCreateSlidingWindowState(params.identifier, now)
  if (state.inFlight >= params.maxConcurrent) {
    return {
      allowed: false,
      limit: params.maxConcurrent,
      inFlight: state.inFlight,
      retryAfterSeconds: 1,
      release: () => undefined,
    }
  }

  state.inFlight += 1
  let released = false

  return {
    allowed: true,
    limit: params.maxConcurrent,
    inFlight: state.inFlight,
    retryAfterSeconds: null,
    release: () => {
      if (released) {
        return
      }

      released = true
      const current = slidingWindowStates.get(params.identifier)
      if (!current) {
        return
      }

      current.inFlight = Math.max(0, current.inFlight - 1)
      current.lastSeenAt = Date.now()
    },
  }
}
