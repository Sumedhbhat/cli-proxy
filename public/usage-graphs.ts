import type { Report, Helpers, UsageView } from "./usage.ts";
import type { QuotaSample } from "../src/quota-history.ts";
import { taskAnalytics } from "../src/task-analytics.ts";
const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const usd = (n: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
const stamp = (s: string) =>
  new Date(s).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
function quotaGraph(provider: string, all: QuotaSample[], h: Helpers) {
  const samples = all
    .filter((s) => s.provider === provider)
    .sort((a, b) => a.at.localeCompare(b.at));
  const latest = samples.at(-1),
    name = provider === "claude" ? "Claude" : "Codex";
  const series = new Map<string, QuotaSample[]>();
  for (const s of samples) {
    const k = s.account + ":" + s.window;
    series.set(k, [...(series.get(k) || []), s]);
  }
  const start = samples.length
      ? Date.parse(samples[0].at)
      : Date.now() - 86400000,
    end = Math.max(
      Date.now(),
      Date.parse(samples.at(-1)?.at || new Date().toISOString()),
    );
  const x = (at: string) =>
      42 + (300 * (Date.parse(at) - start)) / Math.max(3600000, end - start),
    y = (n: number) => 174 - 1.4 * n;
  const lines = [...series.values()]
    .map((points, i) => {
      let path = "";
      points.forEach((p, j) => {
        const last = points[j - 1];
        const gap =
          !last || Date.parse(p.at) - Date.parse(last.at) > 6 * 3600000;
        path += `${gap ? "M" : "L"}${x(p.at).toFixed(1)},${y(p.remaining).toFixed(1)} `;
      });
      return (
        `<path d="${path}" fill="none" stroke="var(--series-${provider})" stroke-width="2.3" opacity="${Math.max(0.4, 1 - i * 0.12)}" ${points[0]?.source === "native-cli" ? 'stroke-dasharray="5 4"' : ""}/>` +
        points
          .map(
            (p) =>
              `<g class="trend-day" tabindex="0" data-tip="${h.esc(`${stamp(p.at)} · ${p.remaining.toFixed(1)}% remaining · ${p.source === "native-cli" ? "CLI history, account unknown" : "Account " + (i + 1)} · ${p.window}`)}"><circle cx="${x(p.at)}" cy="${y(p.remaining)}" r="3" fill="var(--series-${provider})"/><title>${h.esc(stamp(p.at) + ": " + p.remaining.toFixed(1) + "% remaining")}</title></g>`,
          )
          .join("")
      );
    })
    .join("");
  const same = latest
      ? series.get(latest.account + ":" + latest.window) || []
      : [],
    prev = [...same]
      .reverse()
      .find(
        (p) =>
          latest &&
          p.resetsAt === latest.resetsAt &&
          Date.parse(latest.at) - Date.parse(p.at) >= 15 * 60000,
      );
  const rate =
    latest && prev
      ? Math.max(
          0,
          (prev.remaining - latest.remaining) /
            ((Date.parse(latest.at) - Date.parse(prev.at)) / 3600000),
        )
      : null;
  return `<section class="panel quota-graph"><h2>${name} weekly limit</h2><div class="graph-number">${latest ? latest.remaining.toFixed(1) + "%" : "—"}<small>remaining</small></div><p class="graph-caption">${rate === null ? "Collecting burn rate" : rate.toFixed(1) + " percentage points / hour"}${latest?.resetsAt ? " · resets " + h.esc(stamp(latest.resetsAt)) : ""}</p><div class="chart-wrap"><svg viewBox="0 0 360 205" role="img" aria-label="${name} weekly quota remaining over time">${[0, 50, 100].map((v) => `<line class="grid" x1="42" x2="342" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="35" y="${y(v) + 4}" text-anchor="end">${v}%</text>`).join("")}${lines}<text class="axis" x="42" y="199">${h.esc(stamp(new Date(start).toISOString()))}</text><text class="axis" x="342" y="199" text-anchor="end">Now</text></svg><div class="chart-tip" hidden></div>${!samples.length ? '<p class="chart-empty">No retained quota snapshots for this range. New observations are collected automatically.</p>' : ""}</div><details><summary>Quota history</summary><p class="fine">Provider observations, per account/window. Resets rise back toward 100% when reported. Gaps are missing observations. Dashed lines are recovered CLI snapshots with unknown account identity.</p>${latest ? `<p class="fine">Last observed ${h.esc(stamp(latest.at))}</p>` : ""}</details></section>`;
}
function dailyGraph(report: Report, h: Helpers, view: UsageView) {
  const days = new Map<
    string,
    { value: number; tokens: number; unpriced: number }
  >();
  for (const u of report.activity || []) {
    const d = days.get(u.group.day) || { value: 0, tokens: 0, unpriced: 0 };
    d.tokens += u.group.tokens.total || 0;
    if (u.estimatedUsd != null) d.value += u.estimatedUsd;
    else d.unpriced++;
    days.set(u.group.day, d);
  }
  if (!days.size)
    for (const d of report.daily) {
      const row = days.get(d.day) || { value: 0, tokens: 0, unpriced: 0 };
      row.value += (d.low + d.high) / 2;
      row.tokens += d.total;
      days.set(d.day, row);
    }
  const list = [...days].sort(([a], [b]) => a.localeCompare(b));
  const tokens = view.metric === "tokens";
  const max = Math.max(
      1,
      ...list.map(([, d]) => (tokens ? d.tokens : d.value)),
    ),
    step = 300 / Math.max(1, list.length);
  return `<section class="panel"><h2>Daily ${tokens ? "tokens" : "usage value"}</h2><p class="graph-caption">${tokens ? "Reported tokens" : "API-equivalent estimate · USD"}</p><div class="chart-wrap"><svg viewBox="0 0 360 235" role="img" aria-label="Daily ${tokens ? "tokens" : "API-equivalent value"}">${[0, 0.5, 1].map((f) => `<line class="grid" x1="44" x2="344" y1="${190 - f * 156}" y2="${190 - f * 156}"/><text class="axis" x="37" y="${194 - f * 156}" text-anchor="end">${tokens ? compact.format(max * f) : usd(max * f)}</text>`).join("")}${list
    .map(([day, d], i) => {
      const value = tokens ? d.tokens : d.value;
      const height = (value / max) * 156;
      return `<g class="trend-day" tabindex="0" data-tip="${h.esc(day + " · " + (tokens ? whole.format(value) + " tokens" : usd(value)) + (d.unpriced ? " · " + d.unpriced + " unpriced observations" : ""))}"><rect class="hit" x="${44 + i * step}" y="34" width="${step}" height="156"/><rect x="${45 + i * step}" y="${190 - height}" width="${Math.max(1, step - 2)}" height="${height}" rx="2" fill="var(--green)"/>${i % Math.ceil(list.length / 4) === 0 ? `<text class="axis" x="${44 + i * step}" y="211">${day.slice(5)}</text>` : ""}</g>`;
    })
    .join(
      "",
    )}</svg><div class="chart-tip" hidden></div></div><select data-usage-field="metric" aria-label="Daily chart measure"><option value="value" ${!tokens ? "selected" : ""}>API-equivalent value</option><option value="tokens" ${tokens ? "selected" : ""}>Tokens</option></select><details><summary>Sources and gaps</summary><p class="fine">Recovered T3 usage is valued using its retained rate snapshot or reported cost, not a subscription bill. Missing rates are unpriced, not free. Gateway estimates use the dated catalog. Days without observations are gaps.</p></details></section>`;
}
function bars(
  title: string,
  rows: Array<{ name: string; value: number; detail?: string }>,
  format: (n: number) => string,
  h: Helpers,
) {
  const sorted = rows
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10),
    max = Math.max(1, ...sorted.map((r) => r.value));
  return `<section class="panel analytics-bars"><h2>${h.esc(title)}</h2>${sorted.length ? `<ol>${sorted.map((r) => `<li><div><span title="${h.esc(r.name)}">${h.esc(r.name)}</span><strong>${format(r.value)}</strong></div><div class="metric-track"><i style="width:${(100 * r.value) / max}%"></i></div>${r.detail ? `<small>${h.esc(r.detail)}</small>` : ""}</li>`).join("")}</ol>` : '<p class="chart-empty">No attributed observations for these filters yet.</p>'}</section>`;
}
function distribution(activity: NonNullable<Report["activity"]>, h: Helpers) {
  const a = taskAnalytics(activity),
    s = a.stats;
  const binCount = s.min === s.max ? 1 : 8;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: s.min + ((s.max - s.min) * i) / binCount,
    to: s.min + ((s.max - s.min) * (i + 1)) / binCount,
    count: 0,
  }));
  for (const task of a.tasks)
    bins[
      Math.min(
        binCount - 1,
        Math.floor(
          (binCount * (task.tokens - s.min)) / Math.max(1, s.max - s.min),
        ),
      )
    ].count++;
  const max = Math.max(1, ...bins.map((b) => b.count));
  return `<section class="panel task-distribution"><h2>Tokens per T3 conversation</h2><div class="task-stats">${[
    ["Average", s.mean],
    ["Median", s.median],
    ["Lowest", s.min],
    ["Highest", s.max],
    ["Range", s.range],
    ["Std. deviation", s.standardDeviation],
    ["Variance · tokens²", s.variance],
    ["Conversations", s.count],
  ]
    .map(
      ([label, n]) =>
        `<div><span>${label}</span><strong>${s.count ? compact.format(Number(n)) : "—"}</strong></div>`,
    )
    .join(
      "",
    )}</div><div class="chart-wrap"><svg viewBox="0 0 600 190" role="img" aria-label="Distribution of tokens per T3 conversation">${bins.map((b, i) => `<g class="trend-day" tabindex="0" data-tip="${h.esc(whole.format(b.from) + "–" + whole.format(b.to) + " tokens · " + b.count + " conversations")}"><rect class="hit" x="${24 + i * 70}" y="12" width="66" height="145"/><rect x="${25 + i * 70}" y="${157 - (b.count / max) * 135}" width="62" height="${(b.count / max) * 135}" fill="var(--blue)" rx="3"/><text class="axis" x="${55 + i * 70}" y="177" text-anchor="middle">${compact.format(b.from)}</text><text class="axis" x="${55 + i * 70}" y="${149 - (b.count / max) * 135}" text-anchor="middle">${b.count || ""}</text></g>`).join("")}</svg><div class="chart-tip" hidden></div></div><details><summary>Statistics and coverage</summary><p class="fine">${s.count} mapped T3 conversations within the selected range. Population variance: ${whole.format(s.variance)} tokens². Standard deviation measures spread around the average. ${a.unassigned} usage observations could not be mapped to a T3 conversation and are excluded from task statistics. A conversation can be partial at range boundaries.</p></details></section>`;
}
export function topGraphs(report: Report, h: Helpers, view: UsageView) {
  return `<div class="usage-graphs">${quotaGraph("claude", report.quotaHistory || [], h)}${quotaGraph("codex", report.quotaHistory || [], h)}${dailyGraph(report, h, view)}</div>`;
}
export function projectGraphs(report: Report, h: Helpers) {
  const activity = report.activity || [],
    a = taskAnalytics(activity);
  return `<details class="analytics-section" open><summary>Projects & conversations <span class="tag">Read-only T3 history</span></summary>${distribution(activity, h)}<div class="analytics-grid">${bars(
    "API-equivalent value by project",
    a.projects.map((p) => ({
      name: p.name,
      value: p.value,
      detail: p.unpriced ? `${p.unpriced} unpriced observations` : undefined,
    })),
    usd,
    h,
  )}${bars(
    "Tokens by project",
    a.projects.map((p) => ({ name: p.name, value: p.tokens })),
    (n) => compact.format(n),
    h,
  )}${bars(
    "Conversations per project",
    a.projects.map((p) => ({ name: p.name, value: p.tasks })),
    (n) => whole.format(n),
    h,
  )}${bars(
    "Largest conversations by value",
    a.tasks.map((t) => ({
      name: t.title,
      value: t.value,
      detail: t.project + " · " + t.turns + " usage observations",
    })),
    usd,
    h,
  )}${bars(
    "Largest conversations by tokens",
    a.tasks.map((t) => ({ name: t.title, value: t.tokens, detail: t.project })),
    (n) => compact.format(n),
    h,
  )}${bars(
    "Usage observations per conversation",
    a.tasks.map((t) => ({ name: t.title, value: t.turns })),
    (n) => whole.format(n),
    h,
  )}${bars(
    "Tokens by model",
    a.models.map((m) => ({ name: m.name, value: m.tokens })),
    (n) => compact.format(n),
    h,
  )}${bars(
    "Token mix",
    [
      {
        name: "Uncached input",
        value: activity.reduce(
          (n, u) => n + (u.group.tokens.inputUncached || 0),
          0,
        ),
      },
      {
        name: "Cache reads",
        value: activity.reduce(
          (n, u) => n + (u.group.tokens.cacheRead || 0),
          0,
        ),
      },
      {
        name: "Cache writes",
        value: activity.reduce(
          (n, u) => n + (u.group.tokens.cacheWrite || 0),
          0,
        ),
      },
      {
        name: "Output, including reasoning",
        value: activity.reduce((n, u) => n + (u.group.tokens.output || 0), 0),
      },
    ],
    (n) => compact.format(n),
    h,
  )}</div></details>`;
}
