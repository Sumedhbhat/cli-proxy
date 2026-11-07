// Pure accounting rules: provider token semantics, record completeness,
// tier resolution, and API-equivalent estimates. No I/O happens here.
import {
  PRICES,
  PRICING_CATALOG_VERSION,
  longContextThreshold,
} from "./pricing.ts";
import type { ContextBucket, Price, PriceTier } from "./pricing.ts";

// Bump when a rule below changes how stored tokens or estimates are derived.
export const ACCOUNTING_VERSION = 1;

export type UsageStatus = "complete" | "partial" | "estimated" | "unknown";
export type Outcome = "success" | "failed" | "rejected" | "interrupted";

export interface RawTokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cached: number;
  readonly cache_read: number;
  readonly cache_creation: number;
  readonly total: number;
}

// Mutually exclusive buckets. Null means the provider did not report it.
// `total` = inputUncached + cacheRead + cacheWrite + output; reasoning is a
// subset of output and is never added again.
export interface Tokens {
  readonly inputUncached: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly total: number | null;
}

export interface Classified {
  readonly tokens: Tokens;
  readonly status: UsageStatus;
  readonly note: string | null;
}

const unknownTokens: Tokens = {
  inputUncached: null,
  cacheRead: null,
  cacheWrite: null,
  output: null,
  reasoning: null,
  total: null,
};

const counters = (raw: RawTokens) => [
  raw.input,
  raw.output,
  raw.reasoning,
  raw.cached,
  raw.cache_read,
  raw.cache_creation,
  raw.total,
];

/**
 * Applies each provider's token semantics to the engine's raw counters.
 *
 * - Claude (Anthropic Messages): input_tokens excludes cache reads and writes;
 *   output_tokens already includes thinking. The engine's CachedTokens falls
 *   back to cache *creation* for Claude, so it is deliberately ignored.
 * - Codex (OpenAI Responses): input_tokens includes cached tokens; output
 *   tokens include reasoning tokens.
 *
 * An execution with no reported counters is unknown, never zero.
 */
export function classifyTokens(
  provider: string,
  raw: RawTokens,
  failed: boolean,
): Classified {
  const values = counters(raw);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    return {
      tokens: unknownTokens,
      status: "unknown",
      note: "Invalid counters",
    };
  if (values.every((value) => value === 0))
    return {
      tokens: unknownTokens,
      status: "unknown",
      note: failed
        ? "Failed before the provider reported usage"
        : "Provider reported no usage",
    };
  const status: UsageStatus = failed ? "partial" : "complete";
  const failedNote = failed
    ? "Interrupted or failed; counts are what was reported before the end"
    : null;
  if (provider === "claude") {
    const reasoning = raw.reasoning <= raw.output ? raw.reasoning : null;
    const total = raw.input + raw.cache_read + raw.cache_creation + raw.output;
    return {
      tokens: {
        inputUncached: raw.input,
        cacheRead: raw.cache_read,
        cacheWrite: raw.cache_creation,
        output: raw.output,
        reasoning,
        total,
      },
      status: reasoning === null ? "partial" : status,
      note: reasoning === null ? "Reasoning exceeds output" : failedNote,
    };
  }
  if (provider === "codex") {
    const cacheRead = raw.cache_read || raw.cached;
    const uncached = raw.input - cacheRead - raw.cache_creation;
    if (uncached < 0 || raw.reasoning > raw.output)
      return {
        tokens: {
          ...unknownTokens,
          total: raw.total || raw.input + raw.output,
        },
        status: "partial",
        note: "Inconsistent provider counters; only the total is kept",
      };
    return {
      tokens: {
        inputUncached: uncached,
        cacheRead,
        cacheWrite: raw.cache_creation,
        output: raw.output,
        reasoning: raw.reasoning,
        total: raw.input + raw.output,
      },
      status,
      note: failedNote,
    };
  }
  // Unknown protocol: keep the authoritative total without guessing buckets.
  return {
    tokens: { ...unknownTokens, total: raw.total || null },
    status: raw.total ? "partial" : "unknown",
    note: "Provider token semantics are not classified",
  };
}

export function classifyOutcome(failed: boolean, status: number): Outcome {
  if (!failed) return "success";
  // 499 is the engine's client-closed status; 408 a timeout.
  if (status === 499 || status === 408) return "interrupted";
  if (status >= 400 && status < 500) return "rejected";
  return "failed";
}

const normalTier = (tier: string) => tier.trim().toLowerCase();
/**
 * Resolves the billing tier from the most authoritative value present: the
 * upstream response, then the outbound request, then the client request.
 */
export function resolveTier(
  provider: string,
  response: string,
  effective: string,
  requested: string,
): string {
  const tier =
    [response, effective, requested].map(normalTier).find((t) => t !== "") ??
    "";
  if (provider === "claude")
    return tier === "fast"
      ? "fast"
      : ["", "standard", "default", "auto", "standard_only"].includes(tier)
        ? "standard"
        : tier;
  if (provider === "codex")
    return ["", "default", "auto", "standard"].includes(tier)
      ? "standard"
      : tier === "priority" || tier === "fast"
        ? "fast"
        : tier;
  return tier || "standard";
}

export function contextBucket(
  provider: string,
  model: string,
  tokens: Tokens,
): ContextBucket {
  const threshold = longContextThreshold(provider, model);
  if (threshold === null) return "standard";
  const prompt =
    (tokens.inputUncached ?? 0) +
    (tokens.cacheRead ?? 0) +
    (tokens.cacheWrite ?? 0);
  return prompt > threshold ? "long" : "standard";
}

export function findPrice(
  provider: string,
  model: string,
  tier: string,
  context: ContextBucket,
  day: string,
  catalog: ReadonlyArray<Price> = PRICES,
): Price | null {
  return (
    catalog
      .filter(
        (price) =>
          price.provider === provider &&
          price.models.includes(model) &&
          price.tier === (tier as PriceTier) &&
          price.context === context &&
          price.effectiveFrom <= day &&
          (price.effectiveUntil === null || day < price.effectiveUntil),
      )
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null
  );
}

export type EstimateStatus =
  | "priced"
  | "partial" // usage is partial, or cache writes have no published rate
  | "no-price" // model, tier, date, or context has no catalog entry
  | "no-usage"; // the provider did not report usage

export interface Estimate {
  readonly low: number;
  readonly high: number;
  readonly status: EstimateStatus;
  readonly priceId: string | null;
}

/** API-equivalent value of one group of tokens that share a price. */
export function estimate(
  tokens: Tokens,
  usage: UsageStatus,
  price: Price | null,
): Estimate {
  if (
    usage === "unknown" ||
    tokens.inputUncached === null ||
    tokens.output === null
  )
    return {
      low: 0,
      high: 0,
      status: tokens.total === null ? "no-usage" : "no-price",
      priceId: null,
    };
  if (!price) return { low: 0, high: 0, status: "no-price", priceId: null };
  const base =
    (tokens.inputUncached * price.input +
      (tokens.cacheRead ?? 0) * price.cacheRead +
      tokens.output * price.output) /
    1e6;
  const writes = tokens.cacheWrite ?? 0;
  const writeUnpriced =
    writes > 0 &&
    (price.cacheWriteLow === null || price.cacheWriteHigh === null);
  return {
    low: base + (writes * (price.cacheWriteLow ?? 0)) / 1e6,
    high: base + (writes * (price.cacheWriteHigh ?? 0)) / 1e6,
    status: usage === "partial" || writeUnpriced ? "partial" : "priced",
    priceId: price.id,
  };
}

export interface CostedGroup {
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
  readonly context: ContextBucket;
  readonly day: string;
  readonly usageStatus: UsageStatus;
  readonly tokens: Tokens;
}

export const estimateGroup = (group: CostedGroup) =>
  estimate(
    group.tokens,
    group.usageStatus,
    findPrice(
      group.provider,
      group.model,
      group.tier,
      group.context,
      group.day,
    ),
  );

export const methodology = {
  accountingVersion: ACCOUNTING_VERSION,
  pricingCatalogVersion: PRICING_CATALOG_VERSION,
  currency: "USD",
} as const;
