import { sql } from "kysely"

import { AGENT_RATE_LIMIT_STORE } from "./agent-runtime-config"
import { getDatabase, isPrimaryDatabaseConfigured } from "./postgres"

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
  release: () => Promise<void> | void
}

interface PersistentSlidingWindowRow {
  hitCount: number | string | bigint
  oldestHit: number | string | bigint | null
}

interface PersistentConcurrencyRow {
  previousInFlight: number | string
  inFlight: number | string
}

type RateLimitStore = "memory" | "postgres"

const slidingWindowStates = new Map<string, SlidingWindowRateLimitState>()
let lastPersistentCleanupAt = 0

function resolveRateLimitStore(): RateLimitStore {
  if (AGENT_RATE_LIMIT_STORE === "memory") {
    return "memory"
  }

  if (AGENT_RATE_LIMIT_STORE === "postgres") {
    return "postgres"
  }

  return isPrimaryDatabaseConfigured() ? "postgres" : "memory"
}

function toNumber(value: number | string | bigint | null | undefined): number {
  if (typeof value === "bigint") {
    return Number(value)
  }

  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

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

function evaluateAndConsumeMemorySlidingWindowRateLimit(params: {
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

async function cleanupPersistentRateLimitStates(
  now: number,
  windowMs: number
): Promise<void> {
  const staleAfterMs = Math.max(windowMs * 2, 120_000)
  const cleanupIntervalMs = Math.min(staleAfterMs, 60_000)

  if (now - lastPersistentCleanupAt < cleanupIntervalMs) {
    return
  }

  lastPersistentCleanupAt = now
  await sql`
    DELETE FROM agent_rate_limit
    WHERE "inFlight" = 0
      AND "lastSeenAt" < ${new Date(now - staleAfterMs)}
  `.execute(getDatabase())
}

async function evaluateAndConsumePersistentSlidingWindowRateLimit(params: {
  identifier: string
  maxRequests: number
  windowMs: number
}): Promise<SlidingWindowRateLimitDecision> {
  const now = Date.now()
  const cutoff = now - params.windowMs
  const lastSeenAt = new Date(now)

  await cleanupPersistentRateLimitStates(now, params.windowMs)

  const result = await sql<PersistentSlidingWindowRow>`
    WITH ensured AS (
      INSERT INTO agent_rate_limit (
        identifier,
        hits,
        "inFlight",
        "lastSeenAt"
      )
      VALUES (
        ${params.identifier},
        '[]'::jsonb,
        0,
        ${lastSeenAt}
      )
      ON CONFLICT (identifier) DO NOTHING
    ),
    current_state AS (
      SELECT hits
      FROM agent_rate_limit
      WHERE identifier = ${params.identifier}
      FOR UPDATE
    ),
    pruned_state AS (
      SELECT
        COALESCE(jsonb_agg(hit_ms ORDER BY hit_ms), '[]'::jsonb) AS pruned_hits,
        COUNT(hit_ms)::integer AS hit_count,
        MIN(hit_ms)::bigint AS oldest_hit
      FROM current_state
      CROSS JOIN LATERAL jsonb_array_elements_text(current_state.hits) AS hit(value)
      CROSS JOIN LATERAL (SELECT hit.value::bigint AS hit_ms) parsed
      WHERE parsed.hit_ms > ${cutoff}
    ),
    updated AS (
      UPDATE agent_rate_limit
      SET
        hits = CASE
          WHEN pruned_state.hit_count >= ${params.maxRequests}
            THEN pruned_state.pruned_hits
          ELSE pruned_state.pruned_hits || jsonb_build_array(${now}::bigint)
        END,
        "lastSeenAt" = ${lastSeenAt}
      FROM pruned_state
      WHERE identifier = ${params.identifier}
      RETURNING
        pruned_state.hit_count AS "hitCount",
        pruned_state.oldest_hit AS "oldestHit"
    )
    SELECT
      "hitCount",
      "oldestHit"
    FROM updated
  `.execute(getDatabase())

  const row = result.rows[0]
  const hitCount = toNumber(row?.hitCount)
  const oldestHit = row?.oldestHit == null ? now : toNumber(row.oldestHit)
  const resetAtEpochSeconds = Math.ceil((oldestHit + params.windowMs) / 1000)

  if (hitCount >= params.maxRequests) {
    return {
      allowed: false,
      limit: params.maxRequests,
      remaining: 0,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldestHit + params.windowMs - now) / 1000)
      ),
      resetAtEpochSeconds,
    }
  }

  return {
    allowed: true,
    limit: params.maxRequests,
    remaining: Math.max(0, params.maxRequests - hitCount - 1),
    retryAfterSeconds: null,
    resetAtEpochSeconds,
  }
}

export async function evaluateAndConsumeSlidingWindowRateLimit(params: {
  identifier: string
  maxRequests: number
  windowMs: number
}): Promise<SlidingWindowRateLimitDecision> {
  if (resolveRateLimitStore() === "memory") {
    return evaluateAndConsumeMemorySlidingWindowRateLimit(params)
  }

  return evaluateAndConsumePersistentSlidingWindowRateLimit(params)
}

function tryAcquireMemoryConcurrencySlot(params: {
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

async function releasePersistentConcurrencySlot(identifier: string) {
  await sql`
    UPDATE agent_rate_limit
    SET
      "inFlight" = GREATEST("inFlight" - 1, 0),
      "lastSeenAt" = ${new Date()}
    WHERE identifier = ${identifier}
  `.execute(getDatabase())
}

async function tryAcquirePersistentConcurrencySlot(params: {
  identifier: string
  maxConcurrent: number
  windowMs: number
}): Promise<ConcurrencySlotDecision> {
  const now = Date.now()
  const lastSeenAt = new Date(now)

  await cleanupPersistentRateLimitStates(now, params.windowMs)

  const result = await sql<PersistentConcurrencyRow>`
    WITH ensured AS (
      INSERT INTO agent_rate_limit (
        identifier,
        hits,
        "inFlight",
        "lastSeenAt"
      )
      VALUES (
        ${params.identifier},
        '[]'::jsonb,
        0,
        ${lastSeenAt}
      )
      ON CONFLICT (identifier) DO NOTHING
    ),
    current_state AS (
      SELECT "inFlight"
      FROM agent_rate_limit
      WHERE identifier = ${params.identifier}
      FOR UPDATE
    ),
    updated AS (
      UPDATE agent_rate_limit
      SET
        "inFlight" = CASE
          WHEN current_state."inFlight" < ${params.maxConcurrent}
            THEN current_state."inFlight" + 1
          ELSE current_state."inFlight"
        END,
        "lastSeenAt" = ${lastSeenAt}
      FROM current_state
      WHERE identifier = ${params.identifier}
      RETURNING
        current_state."inFlight" AS "previousInFlight",
        agent_rate_limit."inFlight" AS "inFlight"
    )
    SELECT
      "previousInFlight",
      "inFlight"
    FROM updated
  `.execute(getDatabase())

  const row = result.rows[0]
  const previousInFlight = toNumber(row?.previousInFlight)
  const inFlight = toNumber(row?.inFlight)
  const allowed = previousInFlight < params.maxConcurrent

  return {
    allowed,
    limit: params.maxConcurrent,
    inFlight,
    retryAfterSeconds: allowed ? null : 1,
    release: allowed
      ? () => releasePersistentConcurrencySlot(params.identifier)
      : () => undefined,
  }
}

export async function tryAcquireConcurrencySlot(params: {
  identifier: string
  maxConcurrent: number
  windowMs: number
}): Promise<ConcurrencySlotDecision> {
  if (resolveRateLimitStore() === "memory") {
    return tryAcquireMemoryConcurrencySlot(params)
  }

  return tryAcquirePersistentConcurrencySlot(params)
}
