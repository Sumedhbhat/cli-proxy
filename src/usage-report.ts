// Pure aggregation of ledger groups into the dashboard report. Every group
// shares one price, so estimates are exact sums of per-group calculations.
import { estimateGroup, methodology } from "./accounting.ts";
import type { EstimateStatus, Tokens, UsageStatus } from "./accounting.ts";
import { PRICES } from "./pricing.ts";
import type { ContextBucket } from "./pricing.ts";

export interface Group {
  readonly day: string;
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
  readonly context: ContextBucket;
  readonly usageStatus: UsageStatus;
  readonly account: string | null;
  readonly device: string | null;
  readonly principal: string;
  readonly classified: boolean;
  readonly outcome: string;
  readonly executions: number;
  readonly tokens: Tokens;
}

const num = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
export const toGroup = (row: Record<string, unknown>): Group => ({
  day: String(row.day),
  provider: String(row.provider),
  model: String(row.model),
  tier: String(row.tier),
  context: row.context === "long" ? "long" : "standard",
  usageStatus: String(row.usageStatus) as UsageStatus,
  account: row.account === null ? null : String(row.account),
  device: row.device === null ? null : String(row.device),
  principal: String(row.principal),
  classified: Number(row.classified) === 1,
  outcome: String(row.outcome),
  executions: Number(row.executions),
  tokens: {
    inputUncached: num(row.inputUncached),
    cacheRead: num(row.cacheRead),
    cacheWrite: num(row.cacheWrite),
    output: num(row.output),
    reasoning: num(row.reasoning),
    total: num(row.total),
  },
});

export interface TokenTotals {
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}
export interface Totals {
  executions: number;
  status: Record<UsageStatus, number>;
  outcomes: Record<string, number>;
  tokens: TokenTotals;
  // Tokens counted in `total` that could not be split into buckets.
  unclassifiedTokens: number;
  estimate: {
    low: number;
    high: number;
    // Executions whose value is included in full, in part, or not at all.
    executions: Record<EstimateStatus, number>;
    unpricedTokens: number;
  };
}

const emptyTotals = (): Totals => ({
  executions: 0,
  status: { complete: 0, partial: 0, estimated: 0, unknown: 0 },
  outcomes: {},
  tokens: {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  },
  unclassifiedTokens: 0,
  estimate: {
    low: 0,
    high: 0,
    executions: { priced: 0, partial: 0, "no-price": 0, "no-usage": 0 },
    unpricedTokens: 0,
  },
});

function add(
  totals: Totals,
  group: Group,
  value: ReturnType<typeof estimateGroup>,
) {
  totals.executions += group.executions;
  totals.status[group.usageStatus] += group.executions;
  totals.outcomes[group.outcome] =
    (totals.outcomes[group.outcome] ?? 0) + group.executions;
  const t = group.tokens;
  totals.tokens.inputUncached += t.inputUncached ?? 0;
  totals.tokens.cacheRead += t.cacheRead ?? 0;
  totals.tokens.cacheWrite += t.cacheWrite ?? 0;
  totals.tokens.output += t.output ?? 0;
  totals.tokens.reasoning += t.reasoning ?? 0;
  totals.tokens.total += t.total ?? 0;
  if (!group.classified) totals.unclassifiedTokens += t.total ?? 0;
  totals.estimate.low += value.low;
  totals.estimate.high += value.high;
  totals.estimate.executions[value.status] += group.executions;
  if (value.status === "no-price")
    totals.estimate.unpricedTokens += t.total ?? 0;
}

const breakdown = (
  groups: ReadonlyArray<{
    group: Group;
    value: ReturnType<typeof estimateGroup>;
  }>,
  key: (group: Group) => string,
) => {
  const out = new Map<string, Totals & { key: string; provider: string }>();
  for (const { group, value } of groups) {
    const k = key(group);
    const entry = out.get(`${group.provider}\u0000${k}`) ?? {
      ...emptyTotals(),
      key: k,
      provider: group.provider,
    };
    add(entry, group, value);
    out.set(`${group.provider}\u0000${k}`, entry);
  }
  return [...out.values()].sort((a, b) => b.tokens.total - a.tokens.total);
};

export const deviceKey = (group: Pick<Group, "device" | "principal">) =>
  group.device ??
  (group.principal === "shared-key" ? "shared-key" : "unattributed");

export function buildReport(rows: ReadonlyArray<Group>) {
  const priced = rows.map((group) => ({ group, value: estimateGroup(group) }));
  const totals = emptyTotals();
  const providers: Record<string, Totals> = {
    claude: emptyTotals(),
    codex: emptyTotals(),
  };
  const days = new Map<
    string,
    {
      day: string;
      provider: string;
      executions: number;
      total: number;
      low: number;
      high: number;
      unknown: number;
    }
  >();
  const missing = new Map<
    string,
    {
      provider: string;
      model: string;
      tier: string;
      context: string;
      executions: number;
      tokens: number;
    }
  >();
  for (const { group, value } of priced) {
    add(totals, group, value);
    add((providers[group.provider] ??= emptyTotals()), group, value);
    const dayKey = `${group.day}\u0000${group.provider}`;
    const day = days.get(dayKey) ?? {
      day: group.day,
      provider: group.provider,
      executions: 0,
      total: 0,
      low: 0,
      high: 0,
      unknown: 0,
    };
    day.executions += group.executions;
    day.total += group.tokens.total ?? 0;
    day.low += value.low;
    day.high += value.high;
    if (group.usageStatus === "unknown") day.unknown += group.executions;
    days.set(dayKey, day);
    if (value.status === "no-price" && group.classified) {
      const k = [group.provider, group.model, group.tier, group.context].join(
        "\u0000",
      );
      const entry = missing.get(k) ?? {
        provider: group.provider,
        model: group.model,
        tier: group.tier,
        context: group.context,
        executions: 0,
        tokens: 0,
      };
      entry.executions += group.executions;
      entry.tokens += group.tokens.total ?? 0;
      missing.set(k, entry);
    }
  }
  return {
    methodology: { ...methodology, dayBoundary: "UTC" },
    totals,
    providers,
    daily: [...days.values()].sort(
      (a, b) =>
        a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider),
    ),
    breakdowns: {
      accounts: breakdown(priced, (g) => g.account ?? "unknown"),
      devices: breakdown(priced, deviceKey),
      models: breakdown(priced, (g) => g.model),
    },
    pricing: {
      missing: [...missing.values()].sort((a, b) => b.tokens - a.tokens),
      sources: [
        ...new Map(
          PRICES.map((p) => [
            p.source,
            { source: p.source, retrievedAt: p.retrievedAt },
          ]),
        ).values(),
      ],
    },
  };
}

export type UsageReport = ReturnType<typeof buildReport>;
