import { z } from "zod"

import {
  TRADING_DESK_ANALYST_KEYS,
  TRADING_DESK_DEPTHS,
} from "@/lib/shared/trading-agents/types"

/**
 * Shared validation for a Trading Desk analysis request. Used by the streaming
 * route, the async-job route, and the Inngest worker so the three entry points
 * never drift.
 */
export const tradingDeskRequestSchema = z.object({
  ticker: z
    .string()
    .trim()
    .min(1)
    .max(15)
    .regex(/^[A-Za-z0-9.\-^=]+$/, "Invalid ticker symbol."),
  tradeDate: z.iso.date("tradeDate must be YYYY-MM-DD.").nullish(),
  analysts: z
    .array(z.enum(TRADING_DESK_ANALYST_KEYS))
    .min(1, "Select at least one analyst.")
    .max(TRADING_DESK_ANALYST_KEYS.length),
  depth: z.enum(TRADING_DESK_DEPTHS).default("shallow"),
  assetType: z.enum(["stock", "crypto"]).default("stock"),
  online: z.boolean().default(true),
  mock: z.boolean().nullish(),
})
