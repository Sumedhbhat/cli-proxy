// Public API list prices used for API-equivalent estimates. These are not
// charges: subscription (OAuth) usage is not billed per token.
//
// Entries are immutable. A price change adds an entry with a later
// `effectiveFrom` and closes the previous one with `effectiveUntil`, so an
// estimate for a past day always uses the price that applied that day.
// Rates are USD per million tokens.

export const PRICING_CATALOG_VERSION = "2026-11-07.1";

export type PriceTier = "standard" | "fast" | "flex";
export type ContextBucket = "standard" | "long";

export interface Price {
  readonly id: string;
  readonly provider: "claude" | "codex";
  readonly models: ReadonlyArray<string>;
  readonly tier: PriceTier;
  readonly context: ContextBucket;
  readonly input: number;
  readonly cacheRead: number;
  // The engine reports cache writes without their duration, so estimates use
  // the cheapest and dearest published write rate as a range. Null: unpublished.
  readonly cacheWriteLow: number | null;
  readonly cacheWriteHigh: number | null;
  readonly output: number;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly source: string;
  readonly retrievedAt: string;
  readonly currency: "USD";
  readonly note?: string;
}

const anthropic = "https://platform.claude.com/docs/en/about-claude/pricing";
const openai = "https://developers.openai.com/api/docs/pricing";
const retrievedAt = "2026-11-07";

type Rates = readonly [
  input: number,
  cacheRead: number,
  writeLow: number | null,
  writeHigh: number | null,
  output: number,
];
const entry = (
  provider: Price["provider"],
  models: ReadonlyArray<string>,
  tier: PriceTier,
  context: ContextBucket,
  [input, cacheRead, cacheWriteLow, cacheWriteHigh, output]: Rates,
  extra: Partial<Pick<Price, "effectiveUntil" | "note">> = {},
): Price => ({
  id: `${provider}:${models[0]}:${tier}:${context}:${retrievedAt}`,
  provider,
  models,
  tier,
  context,
  input,
  cacheRead,
  cacheWriteLow,
  cacheWriteHigh,
  output,
  effectiveFrom: retrievedAt,
  effectiveUntil: extra.effectiveUntil ?? null,
  source: provider === "claude" ? anthropic : openai,
  retrievedAt,
  currency: "USD",
  ...(extra.note ? { note: extra.note } : {}),
});

// Claude: [input, cache hit, 5-minute write, 1-hour write, output].
const claude = (
  models: ReadonlyArray<string>,
  rates: Rates,
  tier: PriceTier = "standard",
  context: ContextBucket = "standard",
) => entry("claude", models, tier, context, rates);
// OpenAI: [input, cached input, 30-minute write, 12-hour write, output].
const codex = (
  models: ReadonlyArray<string>,
  standard: { short: Rates; long: Rates },
  fast: { short: Rates; long: Rates },
  flex: { short: Rates; long: Rates },
  extra: Partial<Pick<Price, "effectiveUntil" | "note">> = {},
): Price[] =>
  (
    [
      ["standard", standard],
      ["fast", fast],
      ["flex", flex],
    ] as const
  ).flatMap(([tier, rates]) => [
    entry("codex", models, tier, "standard", rates.short, extra),
    entry("codex", models, tier, "long", rates.long, extra),
  ]);

export const PRICES: ReadonlyArray<Price> = [
  claude(["claude-fable-5-1"], [10, 0.25, 12.5, 20, 50]),
  claude(["claude-fable-5"], [10, 1, 12.5, 20, 50]),
  claude(["claude-opus-5-5"], [4, 0.2, 5, 8, 20]),
  claude(["claude-opus-5-5"], [8, 0.4, 10, 16, 40], "fast"),
  claude(["claude-opus-5", "claude-opus-4-8"], [5, 0.5, 6.25, 10, 25]),
  claude(["claude-opus-5", "claude-opus-4-8"], [10, 1, 12.5, 20, 50], "fast"),
  claude(
    ["claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5-20251101"],
    [5, 0.5, 6.25, 10, 25],
  ),
  claude(["claude-sonnet-5-5"], [2, 0.1, 2.5, 4, 10]),
  claude(["claude-sonnet-5"], [2, 0.2, 2.5, 4, 10]),
  claude(["claude-sonnet-4-6"], [3, 0.3, 3.75, 6, 15]),
  // Sonnet 4.5 above 200K input is not covered by the current page: unknown.
  claude(["claude-sonnet-4-5-20250929"], [3, 0.3, 3.75, 6, 15]),
  claude(["claude-haiku-5-5"], [0.1, 0.01, 0.125, 0.2, 0.5]),
  claude(["claude-haiku-5-5"], [0.5, 0.05, 0.625, 1, 2.5], "standard", "long"),
  claude(
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    [1, 0.1, 1.25, 2, 5],
  ),
  ...codex(
    ["gpt-6.1-sol"],
    { short: [2, 0.1, 2.5, 5, 10], long: [4, 0.2, 5, 10, 15] },
    { short: [4, 0.2, 5, 10, 20], long: [8, 0.4, 10, 20, 30] },
    { short: [1, 0.05, 1.25, 2.5, 5], long: [2, 0.1, 2.5, 5, 7.5] },
  ),
  ...codex(
    ["gpt-6-sol"],
    { short: [2, 0.2, 2.5, 5, 10], long: [4, 0.4, 5, 10, 15] },
    { short: [4, 0.4, 5, 10, 20], long: [8, 0.8, 10, 20, 30] },
    { short: [1, 0.1, 1.25, 2.5, 5], long: [2, 0.2, 2.5, 5, 7.5] },
  ),
  ...codex(
    ["gpt-6.1-terra"],
    { short: [1, 0.05, 1.25, 2.5, 5], long: [2, 0.1, 2.5, 5, 7.5] },
    { short: [2, 0.1, 2.5, 5, 10], long: [4, 0.2, 5, 10, 15] },
    { short: [0.5, 0.025, 0.625, 1.25, 2.5], long: [1, 0.05, 1.25, 2.5, 3.75] },
  ),
  ...codex(
    ["gpt-6-luna"],
    {
      short: [0.1, 0.01, 0.125, 0.25, 0.5],
      long: [0.2, 0.02, 0.25, 0.5, 0.75],
    },
    { short: [0.2, 0.02, 0.25, 0.5, 1], long: [0.4, 0.04, 0.5, 1, 1.5] },
    {
      short: [0.05, 0.005, 0.0625, 0.125, 0.25],
      long: [0.1, 0.01, 0.125, 0.25, 0.375],
    },
  ),
  ...codex(
    ["gpt-5.6-sol"],
    { short: [4, 0.4, 5, 10, 20], long: [8, 0.8, 10, 20, 30] },
    { short: [8, 0.8, 10, 20, 40], long: [16, 1.6, 20, 40, 60] },
    { short: [2, 0.2, 2.5, 5, 10], long: [4, 0.4, 5, 10, 15] },
    {
      effectiveUntil: "2026-12-01",
      note: "Promotional price published until November 30, 2026; later price unknown.",
    },
  ),
  // Cache-write rates for these models were not captured: writes stay unpriced.
  ...codex(
    ["gpt-6-astra"],
    { short: [10, 1, null, null, 50], long: [20, 2, null, null, 75] },
    { short: [20, 2, null, null, 100], long: [40, 4, null, null, 150] },
    { short: [5, 0.5, null, null, 25], long: [10, 1, null, null, 37.5] },
  ),
  ...codex(
    ["gpt-5.6-terra"],
    { short: [2, 0.2, null, null, 12], long: [4, 0.4, null, null, 18] },
    { short: [4, 0.4, null, null, 24], long: [8, 0.8, null, null, 36] },
    { short: [1, 0.1, null, null, 6], long: [2, 0.2, null, null, 9] },
  ),
  ...codex(
    ["gpt-5.6-luna"],
    { short: [0.2, 0.02, null, null, 1.2], long: [0.4, 0.04, null, null, 1.8] },
    { short: [0.4, 0.04, null, null, 2.4], long: [0.8, 0.08, null, null, 3.6] },
    { short: [0.1, 0.01, null, null, 0.6], long: [0.2, 0.02, null, null, 0.9] },
  ),
];

// Thresholds where a provider bills the whole request at long-context rates.
// Claude 4.6+ (except Haiku 5.5) has no long-context premium.
export const longContextThreshold = (
  provider: string,
  model: string,
): number | null =>
  provider === "codex"
    ? 272_000
    : model === "claude-haiku-5-5"
      ? 100_000
      : model === "claude-sonnet-4-5-20250929"
        ? 200_000
        : null;
