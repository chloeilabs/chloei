import { z } from "zod"

/**
 * Centralized, typed access to the optional server-side service keys.
 *
 * Why this exists: these keys were previously read ad hoc via
 * `process.env.*` in several route handlers, with inconsistent trimming. This
 * module is the single source of truth for them.
 *
 * Behavior contract (intentionally non-breaking):
 * - Accessors read `process.env` at call time, preserving the existing
 *   per-request read semantics.
 * - They never throw: a blank or whitespace-only value normalizes to
 *   `undefined` (i.e. "not configured"), matching how `OPENAI_API_KEY` was
 *   already treated in the follow-ups route and gateway error handling.
 *
 * Out of scope (left where they already live, by design):
 * - Required auth/database vars (`DATABASE_URL`, `BETTER_AUTH_*`) — handled
 *   gracefully by `auth.ts` / `postgres.ts` (`isAuthConfigured()`).
 * - Feature flags (`AGENT_TELEMETRY_RECORD_IO`, Edge Config) — `integration-flags.ts`.
 */

/** Optional secret: trimmed, with blank/whitespace normalized to `undefined`. */
const optionalSecret = z.string().trim().min(1).optional().catch(undefined)

function readOptionalSecret(
  name: "OPENAI_API_KEY" | "EXA_API_KEY"
): string | undefined {
  return optionalSecret.parse(process.env[name])
}

/** OpenAI API key. Gates `/api/models` and `/api/agent`. */
export function getOpenAiApiKey(): string | undefined {
  return readOptionalSecret("OPENAI_API_KEY")
}

/** Exa key. Enables the `exa_search` / `exa_get_contents` tools when set. */
export function getExaApiKey(): string | undefined {
  return readOptionalSecret("EXA_API_KEY")
}
