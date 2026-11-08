// "Usage & cost" page. Three separate figures, never mixed:
// observed tokens, API-equivalent value (an estimate, not a charge), and
// actual spending (only from billing records).
import { topGraphs, projectGraphs } from "./usage-graphs.ts";
import type { QuotaSample, NativeUsage } from "../src/quota-history.ts";
import type { Totals, UsageReport } from "../src/usage-report.ts";

type Row = Record<string, unknown>;
export interface Report extends UsageReport {
  readonly quotaHistory?: QuotaSample[];
  readonly activity?: NativeUsage[];
  readonly generatedAt: string;
  readonly coverage: {
    readonly trackingStartedAt: string | null;
    readonly firstExecutionAt: string | null;
    readonly lastExecutionAt: string | null;
    readonly writers: ReadonlyArray<Row>;
    readonly events: ReadonlyArray<Row>;
    readonly counters: Record<string, number>;
    readonly gatewayRequests: ReadonlyArray<Row>;
    readonly ingest: {
      lastSuccessAt: string | null;
      lastError: string | null;
      backlogBytes: number;
      outboxDir: string;
    };
    readonly plugin: { known: boolean; loaded: boolean; detail: string };
    readonly attributionEnabled: boolean;
  };
  readonly spending: {
    readonly totals: Record<string, Record<string, number>>;
    readonly records: ReadonlyArray<Row>;
    readonly imports: ReadonlyArray<Row>;
  };
  readonly options: {
    readonly accounts: ReadonlyArray<Row>;
    readonly models: ReadonlyArray<Row>;
    readonly devices: ReadonlyArray<Row>;
    readonly deviceLabels: ReadonlyArray<{
      id: string;
      label: string;
      createdAt: string;
      revokedAt: string | null;
    }>;
  };
}

export interface UsageView {
  range: string;
  from: string;
  to: string;
  provider: string;
  account: string;
  device: string;
  model: string;
  breakdown: "accounts" | "devices" | "models";
  metric: "tokens" | "value";
  newKey: { id: string; label: string; key: string } | null;
}

export const usageView: UsageView = {
  range: "30",
  from: "",
  to: "",
  provider: "all",
  account: "",
  device: "",
  model: "",
  breakdown: "devices",
  metric: "value",
  newKey: null,
};

const utcDay = (offsetDays = 0) =>
  new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
export function usageQuery(view: UsageView = usageView) {
  const params = new URLSearchParams();
  if (view.range === "custom") {
    if (view.from) params.set("from", view.from);
    if (view.to) params.set("to", view.to);
  } else if (view.range !== "all") {
    params.set("from", utcDay(Number(view.range) - 1));
    params.set("to", utcDay());
  }
  if (view.provider !== "all") params.set("provider", view.provider);
  for (const key of ["account", "device", "model"] as const)
    if (view[key]) params.set(key, view[key]);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export interface Helpers {
  readonly esc: (value: unknown) => string;
  readonly mark: (provider: string) => string;
  readonly pName: (provider: string) => string;
  readonly mask: (value: string) => string;
  readonly heading: (actions: string) => string;
}

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const whole = new Intl.NumberFormat("en");
const tokens = (n: number) =>
  n >= 10000 ? compact.format(n) : whole.format(n);
export function usd(n: number) {
  if (n === 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${whole.format(Math.round(n))}`;
}
const range = (low: number, high: number) =>
  Math.abs(high - low) < 0.005 ? usd(low) : `${usd(low)}–${usd(high)}`;
const money = (minor: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(
      minor / 100,
    );
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
};
const when = (iso: unknown) =>
  typeof iso === "string" && iso
    ? new Date(iso).toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const incomplete = (t: Totals) => t.status.partial + t.status.unknown;

function filters(report: Report | null, h: Helpers, view: UsageView) {
  const option = (value: string, label: string, selected: string) =>
    `<option value="${h.esc(value)}" ${value === selected ? "selected" : ""}>${h.esc(label)}</option>`;
  const providerFilter = (row: Row) =>
    view.provider === "all" || row.provider === view.provider;
  const labels = new Map(
    report?.options.deviceLabels.map((d) => [d.id, d.label]) ?? [],
  );
  return `<div class="usage-filters" role="group" aria-label="Usage filters">
    <div class="tabs" role="tablist" aria-label="Provider">${[
      "all",
      "claude",
      "codex",
    ]
      .map(
        (p) =>
          `<button class="tab ${view.provider === p ? "active" : ""}" role="tab" aria-selected="${view.provider === p}" data-usage-provider="${p}">${h.mark(p)}${p === "all" ? "All providers" : h.pName(p)}</button>`,
      )
      .join("")}</div>
    <label>Range<select data-usage-field="range">${option("7", "Last 7 days", view.range)}${option("30", "Last 30 days", view.range)}${option("90", "Last 90 days", view.range)}${option("all", "All time", view.range)}${option("custom", "Custom", view.range)}</select></label>
    ${view.range === "custom" ? `<label>From<input type="date" data-usage-field="from" value="${h.esc(view.from)}"></label><label>To<input type="date" data-usage-field="to" value="${h.esc(view.to)}"></label>` : ""}
    <label>Account<select data-usage-field="account">${option("", "All accounts", view.account)}${(
      report?.options.accounts ?? []
    )
      .filter(providerFilter)
      .map((a) => option(String(a.id), h.mask(String(a.id)), view.account))
      .join("")}</select></label>
    <label>Device<select data-usage-field="device">${option("", "All devices", view.device)}${option("shared-key", "Shared gateway key", view.device)}${[...new Set([...(report?.options.devices ?? []).map((d) => String(d.id)), ...labels.keys()])].map((id) => option(id, labels.get(id) ?? id, view.device)).join("")}</select></label>
    <label>Model<select data-usage-field="model">${option("", "All models", view.model)}${(
      report?.options.models ?? []
    )
      .filter(providerFilter)
      .map((m) => option(String(m.id), String(m.id), view.model))
      .join("")}</select></label>
  </div>`;
}

function notices(report: Report, h: Helpers) {
  const out: string[] = [];
  const c = report.coverage;
  if (c.plugin.known && !c.plugin.loaded)
    out.push(
      `<div class="notice error">The engine's usage ledger plugin is not loaded (${h.esc(c.plugin.detail)}). New traffic is not being recorded. See <code>docs/usage-ledger.md</code>.</div>`,
    );
  else if (!c.plugin.known)
    out.push(
      `<div class="notice">${h.esc(c.plugin.detail)}. Recording status is unknown.</div>`,
    );
  if (!c.attributionEnabled)
    out.push(
      '<div class="notice">Device attribution is off: <code>LEDGER_DEVICE_SECRET</code> is not set, so all traffic is recorded under the shared gateway key.</div>',
    );
  if (c.ingest.lastError)
    out.push(
      `<div class="notice error">Ingestion is retrying: ${h.esc(c.ingest.lastError)}. Records stay in the outbox until it succeeds.</div>`,
    );
  return out.join("");
}

function figures(report: Report) {
  const t = report.totals;
  const spend = Object.entries(report.spending.totals);
  const estimated = t.estimate.executions;
  const pricedShare = t.executions ? estimated.priced + estimated.partial : 0;
  return `<div class="usage-figures">
    <article class="panel figure"><h2>Observed tokens</h2><div class="metric">${tokens(t.tokens.total)}</div>
      <p>Reported by Claude and Codex for ${whole.format(t.executions)} executions through this gateway.</p>
      <div class="field-row"><span>Input (uncached)</span><span>${tokens(t.tokens.inputUncached)}</span></div>
      <div class="field-row"><span>Cache reads</span><span>${tokens(t.tokens.cacheRead)}</span></div>
      <div class="field-row"><span>Cache writes</span><span>${tokens(t.tokens.cacheWrite)}</span></div>
      <div class="field-row"><span>Output <small>incl. ${tokens(t.tokens.reasoning)} reasoning</small></span><span>${tokens(t.tokens.output)}</span></div>
      <div class="field-row"><span>Incomplete records</span><span class="${incomplete(t) ? "warn" : ""}">${whole.format(t.status.partial)} partial · ${whole.format(t.status.unknown)} unknown</span></div></article>
    <article class="panel figure"><h2>API-equivalent value <span class="tag">Estimate</span></h2><div class="metric">${range(t.estimate.low, t.estimate.high)}</div>
      <p>What these tokens would cost at public API list prices. Subscription usage is <strong>not</strong> billed per token; this is not a charge.</p>
      <div class="field-row"><span>Executions priced</span><span>${whole.format(pricedShare)} of ${whole.format(t.executions)}</span></div>
      <div class="field-row"><span>No price available</span><span class="${t.estimate.unpricedTokens ? "warn" : ""}">${tokens(t.estimate.unpricedTokens)} tokens</span></div>
      <div class="field-row"><span>No usage reported</span><span>${whole.format(estimated["no-usage"])} ${estimated["no-usage"] === 1 ? "execution" : "executions"}</span></div>
      <p class="fine">The range covers cache writes priced at the shortest and longest published cache duration; the engine does not report which was used.</p></article>
    <article class="panel figure"><h2>Actual spending <span class="tag">Billing records</span></h2>
      ${
        spend.length
          ? spend
              .map(
                ([
                  currency,
                  v,
                ]) => `<div class="metric">${money(v.spend, currency)}</div>
          <div class="field-row"><span>Plans</span><span>${money(v.subscription, currency)}</span></div>
          <div class="field-row"><span>Credit purchases</span><span>${money(v.credit_purchase, currency)}</span></div>
          <div class="field-row"><span>Usage charges</span><span>${money(v.usage_charge, currency)}</span></div>
          <div class="field-row"><span>Refunds</span><span>${v.refund ? "−" : ""}${money(v.refund, currency)}</span></div>
          <div class="field-row"><span>Paid from credits <small>not added again</small></span><span>${money(v.credit_consumption, currency)}</span></div>`,
              )
              .join("")
          : '<div class="metric faint">—</div><p>No billing records overlap this range. Add plan fees or import invoices below; money is never inferred from tokens.</p>'
      }
      <p class="fine">Spending is per account and period, not per device. Splitting a plan fee across devices by tokens would be an allocation, not a measurement.</p></article>
  </div>`;
}

function providerCards(report: Report, h: Helpers) {
  return `<div class="grid-two">${(["claude", "codex"] as const)
    .map((p) => {
      const t = report.providers[p];
      return `<section class="panel provider-usage">${h.mark(p)}<h2>${h.pName(p)}</h2>
        <div class="field-row"><span>Tokens</span><strong>${tokens(t?.tokens.total ?? 0)}</strong></div>
        <div class="field-row"><span>Executions</span><span>${whole.format(t?.executions ?? 0)}</span></div>
        <div class="field-row"><span>API-equivalent value</span><span>${range(t?.estimate.low ?? 0, t?.estimate.high ?? 0)}</span></div>
        <div class="field-row"><span>Partial / unknown</span><span>${whole.format(t?.status.partial ?? 0)} / ${whole.format(t?.status.unknown ?? 0)}</span></div></section>`;
    })
    .join("")}</div>`;
}

export function trendChart(report: Report, h: Helpers, view: UsageView) {
  const days = [...new Set(report.daily.map((d) => d.day))].sort();
  if (!days.length) return "";
  const value = (d: (typeof report.daily)[number]) =>
    view.metric === "tokens" ? d.total : (d.low + d.high) / 2;
  const byDay = new Map(days.map((day) => [day, { claude: 0, codex: 0 }]));
  for (const d of report.daily)
    if (d.provider === "claude" || d.provider === "codex")
      byDay.get(d.day)![d.provider] += value(d);
  const max = Math.max(
    ...[...byDay.values()].map((v) => v.claude + v.codex),
    1e-9,
  );
  const width = 720,
    height = 220,
    left = 56,
    bottom = 24,
    top = 8;
  const plot = width - left - 8;
  const step = plot / days.length;
  const bar = Math.max(2, Math.min(28, step - 2));
  const y = (v: number) => top + (height - top - bottom) * (1 - v / max);
  const fmt = (v: number) =>
    view.metric === "tokens" ? tokens(Math.round(v)) : usd(v);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const segment = (
    x: number,
    y0: number,
    y1: number,
    cls: string,
    rounded: boolean,
  ) => {
    const hgt = y0 - y1;
    if (hgt <= 0.5) return "";
    // Rounded data end only; the baseline end stays square.
    const r = rounded ? Math.min(4, hgt, bar / 2) : 0;
    return `<path class="${cls}" d="M${x},${y0}V${y1 + r}${r ? `Q${x},${y1} ${x + r},${y1}` : ""}H${x + bar - r}${r ? `Q${x + bar},${y1} ${x + bar},${y1 + r}` : ""}V${y0}Z"/>`;
  };
  const bars = days
    .map((day, i) => {
      const v = byDay.get(day)!;
      const x = left + i * step + (step - bar) / 2;
      const base = y(0);
      const top1 = y(v.claude);
      // A 2px surface gap separates the stacked segments.
      const top2 = y(v.claude + v.codex);
      const gap = v.claude > 0 && v.codex > 0 ? 2 : 0;
      return `<g class="trend-day" data-tip="${h.esc(`${day} UTC · Claude ${fmt(v.claude)} · Codex ${fmt(v.codex)}`)}" tabindex="0" aria-label="${h.esc(`${day}: Claude ${fmt(v.claude)}, Codex ${fmt(v.codex)}`)}">
        <rect class="hit" x="${left + i * step}" y="${top}" width="${step}" height="${height - top - bottom}"/>
        ${segment(x, base, top1, "series-claude", v.codex === 0)}${segment(x, top1 - gap, top2, "series-codex", true)}</g>`;
    })
    .join("");
  const labelEvery = Math.ceil(days.length / 8);
  return `<section class="panel usage-trend"><div class="section-head"><h2>Daily ${view.metric === "tokens" ? "tokens" : "API-equivalent value"} <span>UTC days</span></h2>
      <div class="actions"><div class="legend"><span><i class="series-claude"></i>Claude</span><span><i class="series-codex"></i>Codex</span></div>
      <select data-usage-field="metric" aria-label="Chart measure"><option value="tokens" ${view.metric === "tokens" ? "selected" : ""}>Tokens</option><option value="value" ${view.metric === "value" ? "selected" : ""}>API-equivalent value (midpoint)</option></select></div></div>
    <div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily usage by provider">
      ${ticks.map((t) => `<line class="grid" x1="${left}" x2="${width - 8}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${left - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join("")}
      ${bars}
      ${days.map((day, i) => (i % labelEvery === 0 ? `<text class="axis" x="${left + i * step + step / 2}" y="${height - 6}" text-anchor="middle">${day.slice(5)}</text>` : "")).join("")}
    </svg><div class="chart-tip" role="status" hidden></div></div>
    <details><summary>Show as table</summary><table class="usage-table"><thead><tr><th>Day (UTC)</th><th>Claude</th><th>Codex</th></tr></thead><tbody>${days
      .map(
        (day) =>
          `<tr><td>${day}</td><td>${fmt(byDay.get(day)!.claude)}</td><td>${fmt(byDay.get(day)!.codex)}</td></tr>`,
      )
      .join("")}</tbody></table></details></section>`;
}

function breakdownTable(report: Report, h: Helpers, view: UsageView) {
  const labels = new Map(
    report.options.deviceLabels.map((d) => [d.id, d.label]),
  );
  const name = (key: string) =>
    view.breakdown === "devices"
      ? key === "shared-key"
        ? "Shared gateway key"
        : key === "unattributed"
          ? "Unattributed"
          : (labels.get(key) ?? key)
      : view.breakdown === "accounts"
        ? h.mask(key)
        : key;
  const rows = report.breakdowns[view.breakdown];
  return `<section class="panel"><div class="section-head"><h2>Breakdown</h2><div class="tabs" role="tablist" aria-label="Breakdown">${(
    ["devices", "accounts", "models"] as const
  )
    .map(
      (b) =>
        `<button class="tab ${view.breakdown === b ? "active" : ""}" role="tab" aria-selected="${view.breakdown === b}" data-usage-breakdown="${b}">${b[0].toUpperCase()}${b.slice(1)}</button>`,
    )
    .join("")}</div></div>
    ${
      rows.length
        ? `<div class="table-scroll"><table class="usage-table"><thead><tr><th>${view.breakdown === "devices" ? "Device" : view.breakdown === "accounts" ? "Account" : "Model"}</th><th>Provider</th><th>Executions</th><th>Input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Total</th><th>API-equivalent</th><th>Incomplete</th></tr></thead><tbody>${rows
            .map(
              (r) =>
                `<tr><td>${h.esc(name(r.key))}</td><td>${h.mark(r.provider)}${h.esc(h.pName(r.provider))}</td><td>${whole.format(r.executions)}</td><td>${tokens(r.tokens.inputUncached)}</td><td>${tokens(r.tokens.cacheRead)}</td><td>${tokens(r.tokens.cacheWrite)}</td><td>${tokens(r.tokens.output)}</td><td><strong>${tokens(r.tokens.total)}</strong></td><td>${r.estimate.executions["no-price"] && !r.estimate.low ? "Unknown" : range(r.estimate.low, r.estimate.high)}</td><td>${incomplete(r) ? `<span class="warn">${incomplete(r)}</span>` : "0"}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : '<p class="faint">No executions match these filters.</p>'
    }</section>`;
}

const gapLabels: Record<string, string> = {
  "unclean-stop": "Engine stopped without a clean shutdown",
  "lost-at-shutdown": "Executions not written at engine shutdown",
  dropped: "Executions dropped while storage refused writes",
  "storage-retry": "Outbox writes were retried",
  undecodable: "Engine records the plugin could not read",
  "torn-record": "Partially written record discarded",
};

function coveragePanel(report: Report, h: Helpers) {
  const c = report.coverage;
  const clean = c.writers.filter((w) => w.ended_at !== null).length;
  const cancelledCodex = c.gatewayRequests
    .filter(
      (g) =>
        g.provider === "codex" &&
        Number(g.clientClosed) === 1 &&
        g.transport === "http",
    )
    .reduce((n, g) => n + Number(g.count), 0);
  const gatewayTotal = c.gatewayRequests
    .filter((g) => g.transport === "http")
    .reduce((n, g) => n + Number(g.count), 0);
  return `<section class="panel"><h2>Coverage</h2>
    <p>Only traffic through this gateway since the ledger started is counted. Earlier usage, and usage from clients that connect to providers directly, is not here and cannot be rebuilt from quota percentages.</p>
    <div class="field-row"><span>Tracking since</span><span>${when(c.trackingStartedAt)}</span></div>
    <div class="field-row"><span>Latest execution</span><span>${when(c.lastExecutionAt)}</span></div>
    <div class="field-row"><span>Engine sessions</span><span>${c.writers.length} (${clean} ended, ${c.writers.length - clean} running)</span></div>
    <div class="field-row"><span>Repeated deliveries ignored</span><span>${whole.format(c.counters.duplicate_deliveries ?? 0)}</span></div>
    <div class="field-row"><span>Gateway inference requests</span><span>${whole.format(gatewayTotal)}</span></div>
    <div class="field-row"><span>Codex streams closed by the client</span><span class="${cancelledCodex ? "warn" : ""}">${whole.format(cancelledCodex)}</span></div>
    ${cancelledCodex ? '<p class="fine">CLIProxyAPI does not record a Codex stream the client cancels, so their tokens are missing from the totals. The provider may still have counted them against quota.</p>' : ""}
    <div class="field-row"><span>Ingestion</span><span>${c.ingest.lastError ? '<span class="error">Retrying</span>' : `OK · ${when(c.ingest.lastSuccessAt)}`}${c.ingest.backlogBytes ? ` · ${whole.format(c.ingest.backlogBytes)} bytes pending` : ""}</span></div>
    <h3>Gaps</h3>${
      c.events.length
        ? `<ul class="gap-list">${c.events.map((e) => `<li><strong>${h.esc(gapLabels[String(e.kind)] ?? e.kind)}</strong>${Number(e.count) ? ` · ${e.count}` : ""}<small>${when(e.at)}${e.kind === "unclean-stop" && e.detail ? ` · ${h.esc(e.detail)}` : ""}</small></li>`).join("")}</ul>`
        : '<p class="faint">No gaps recorded.</p>'
    }</section>`;
}

function pricingPanel(report: Report, h: Helpers) {
  const m = report.methodology;
  return `<section class="panel"><h2>Pricing status</h2>
    <div class="field-row"><span>Price catalog</span><code>${h.esc(m.pricingCatalogVersion)}</code></div>
    <div class="field-row"><span>Calculation</span><span>v${m.accountingVersion} · ${h.esc(m.currency)}</span></div>
    ${report.pricing.sources.map((s) => `<div class="field-row"><a class="inline-link" href="${h.esc(s.source)}" target="_blank" rel="noreferrer">${h.esc(new URL(s.source).host)}</a><span>retrieved ${h.esc(s.retrievedAt)}</span></div>`).join("")}
    <p class="fine">Uses the model reported in the response, its service tier, cache reads and writes, and long-context thresholds. Prices apply from their effective date, so past days keep the price of their day. Global (non-regional) routing is assumed.</p>
    <h3>Missing prices</h3>${
      report.pricing.missing.length
        ? `<ul class="gap-list">${report.pricing.missing.map((p) => `<li><strong>${h.esc(p.model)}</strong> · ${h.esc(p.tier)}${p.context === "long" ? " · long context" : ""}<small>${whole.format(p.executions)} executions · ${tokens(p.tokens)} tokens shown as unknown value</small></li>`).join("")}</ul>`
        : '<p class="faint">Every priced model in range has a published price.</p>'
    }</section>`;
}

function devicesPanel(
  report: Report,
  h: Helpers,
  view: UsageView,
  gateway: string,
) {
  const list = report.options.deviceLabels;
  return `<section class="panel"><h2>Devices</h2>
    <p>Give each machine its own gateway key. The gateway identifies the device from the key, never from its IP address or a label the client sends, and signs that identity for the engine. Keys are stored only as hashes.</p>
    ${view.newKey ? `<div class="notice"><span>Key for <strong>${h.esc(view.newKey.label)}</strong>. Copy it now; it will not be shown again.</span></div><pre class="secret">${h.esc(view.newKey.key)}</pre><button class="button small" data-usage-action="copy-key">Copy key</button><p class="fine">Use it in place of <code>PROXY_API_KEY</code>: <code>ANTHROPIC_AUTH_TOKEN</code> for Claude Code, or the Codex provider's API key, with base URL <code>${h.esc(gateway)}</code>.</p>` : ""}
    <form data-usage-form="device" class="inline-form"><label>New device<input name="label" maxlength="60" placeholder="e.g. MacBook" required></label><button class="button primary" type="submit">Create key</button></form>
    ${list.length ? list.map((d) => `<div class="field-row"><div>${h.esc(d.label)}<small> · ${h.esc(d.id)} · created ${when(d.createdAt)}</small></div>${d.revokedAt ? `<span class="faint">Revoked ${when(d.revokedAt)}</span>` : `<button class="button quiet small" data-usage-action="revoke" data-id="${h.esc(d.id)}">Revoke</button>`}</div>`).join("") : '<p class="faint">No device keys yet. Requests with the shared key are grouped under “Shared gateway key”.</p>'}</section>`;
}

function billingPanel(report: Report, h: Helpers) {
  const kinds = [
    "subscription",
    "credit_purchase",
    "usage_charge",
    "credit_consumption",
    "refund",
    "adjustment",
  ];
  const records = report.spending.records.slice(0, 50);
  return `<section class="panel"><h2>Billing records</h2>
    <p>Actual spending comes only from these records. There is no official billing API for Claude or ChatGPT subscriptions, so plan fees are entered or imported here. A record counts in a range when its date or service period overlaps it.</p>
    <form data-usage-form="billing" class="billing-form">
      <label>Date<input type="date" name="date" required></label>
      <label>Kind<select name="kind">${kinds.map((k) => `<option value="${k}">${k.replace("_", " ")}</option>`).join("")}</select></label>
      <label>Provider<select name="provider"><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
      <label>Amount<input name="amount" inputmode="decimal" pattern="\\d+(\\.\\d{1,2})?" placeholder="200.00" required></label>
      <label>Currency<input name="currency" value="USD" maxlength="3" required></label>
      <label>Period start<input type="date" name="period_start"></label>
      <label>Period end<input type="date" name="period_end"></label>
      <label class="wide">Description<input name="description" maxlength="200" placeholder="Optional"></label>
      <button class="button primary" type="submit">Add record</button></form>
    <details><summary>Import CSV</summary><form data-usage-form="import" class="billing-form">
      <p class="fine wide">Columns: <code>date,kind,provider,amount,currency</code>, optionally <code>period_start,period_end,account,description</code>. Imports keep their file name and the coverage period you state; the same file cannot be imported twice.</p>
      <label>Covers from<input type="date" name="coverageStart" required></label><label>Covers to<input type="date" name="coverageEnd" required></label>
      <label class="wide">File<input type="file" name="file" accept=".csv,text/csv" required></label><button class="button" type="submit">Import</button></form></details>
    ${
      records.length
        ? `<div class="table-scroll"><table class="usage-table"><thead><tr><th>Date</th><th>Kind</th><th>Provider</th><th>Amount</th><th>Period</th><th>Source</th><th></th></tr></thead><tbody>${records
            .map(
              (r) =>
                `<tr><td>${h.esc(r.occurredOn)}</td><td>${h.esc(String(r.kind).replace("_", " "))}</td><td>${h.esc(h.pName(String(r.provider)))}</td><td>${money(Number(r.amountMinor), String(r.currency))}</td><td>${r.periodStart ? `${h.esc(r.periodStart)} – ${h.esc(r.periodEnd ?? "")}` : "—"}</td><td>${h.esc(r.source)}</td><td>${r.importId === null ? `<button class="button quiet small" data-usage-action="delete-billing" data-id="${h.esc(r.id)}">Delete</button>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : ""
    }
    ${report.spending.imports.length ? `<h3>Imports</h3>${report.spending.imports.map((i) => `<div class="field-row"><div>${h.esc(i.source)}<small> · covers ${h.esc(i.coverageStart)} – ${h.esc(i.coverageEnd)} · ${h.esc(i.rows)} rows · imported ${when(i.importedAt)}</small></div><button class="button quiet small" data-usage-action="delete-import" data-id="${h.esc(i.id)}">Remove</button></div>`).join("")}` : ""}</section>`;
}

const explainer = `<section class="panel prose"><h2>How to read these numbers</h2>
  <p><strong>Observed tokens</strong> are the counts Claude and Codex reported for each execution that passed through this gateway. Input, cache reads, cache writes, and output are separate buckets that add up to the total. Reasoning is part of output and is never added again. Retries and fallbacks are separate executions because each is a separate provider call; a repeated delivery of the same execution is counted once.</p>
  <p><strong>Partial</strong> means the stream ended early and the counts are what the provider reported before it stopped. <strong>Unknown</strong> means no usage was reported, for example a rejected request. Unknown is never treated as zero.</p>
  <p><strong>API-equivalent value</strong> prices those tokens at public API list prices. It shows what the traffic would cost as API usage. Claude and ChatGPT subscriptions are not charged per token, so this is not what you paid.</p>
  <p><strong>Actual spending</strong> is only what your billing records say. Imported records describe their own coverage period; they are not linked to observed traffic, which starts when the ledger started.</p></section>`;

export function usagePage(
  report: Report | null,
  error: string | null,
  h: Helpers,
  view: UsageView,
  gateway: string,
) {
  const query = usageQuery(view);
  const head = h.heading(
    `<a class="button" href="./api/usage/export${query}${query ? "&" : "?"}format=csv" download>Export CSV</a><a class="button" href="./api/usage/export${query}${query ? "&" : "?"}format=json" download>Export JSON</a><button class="button primary" data-usage-action="reload">↻ Refresh</button>`,
  );
  if (error)
    return `${head}<div class="empty"><h2>Usage unavailable</h2><p>${h.esc(error)}</p><button class="button" data-usage-action="reload">Try again</button></div>`;
  if (!report)
    return `${head}${filters(null, h, view)}<div class="loading">Loading usage…</div>`;
  const empty = report.totals.executions === 0;
  return (
    head +
    notices(report, h) +
    filters(report, h, view) +
    topGraphs(report, h, view) +
    (empty
      ? `<div class="empty"><h2>No usage recorded ${report.coverage.trackingStartedAt ? "for these filters" : "yet"}</h2><p>${report.coverage.trackingStartedAt ? `The ledger has been recording since ${when(report.coverage.trackingStartedAt)}. Widen the range or clear filters.` : "Usage appears here once the engine's ledger plugin is loaded and requests pass through the gateway."}</p></div>`
      : figures(report) +
        providerCards(report, h) +
        breakdownTable(report, h, view)) +
    projectGraphs(report, h) +
    `<div class="grid-two">${coveragePanel(report, h)}${pricingPanel(report, h)}</div>` +
    `<div class="grid-two">${devicesPanel(report, h, view, gateway)}${billingPanel(report, h)}</div>` +
    explainer
  );
}
