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
function quotaGraph(
  provider: string,
  all: QuotaSample[],
  h: Helpers,
  refreshErrors = 0,
) {
  const samples = all
    .filter((s) => s.provider === provider)
    .sort((a, b) => a.at.localeCompare(b.at));
  const latest = samples.at(-1),
    name = provider === "claude" ? "Claude" : "Codex";
  const accounts = [
    ...new Set(
      samples.filter((s) => s.source === "provider").map((s) => s.account),
    ),
  ];
  const seriesKey = (s: QuotaSample) => {
    const account =
      s.source === "native-cli" && accounts.length === 1
        ? accounts[0]
        : s.account;
    const window = /^(weekly|seven_day|secondary_window)$/.test(s.window)
      ? "weekly"
      : s.window;
    return account + ":" + window;
  };
  const series = new Map<string, QuotaSample[]>();
  for (const s of samples) {
    const k = seriesKey(s);
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
        path += `${j === 0 ? "M" : "L"}${x(p.at).toFixed(1)},${y(p.remaining).toFixed(1)} `;
      });
      return (
        `<path d="${path}" fill="none" stroke="var(--series-${provider})" stroke-width="2.3" opacity="${Math.max(0.4, 1 - i * 0.12)}"/>` +
        points
          .map(
            (p) =>
              `<g class="trend-day" tabindex="0" data-tip="${h.esc(`${stamp(p.at)} · ${p.remaining.toFixed(1)}% remaining · ${p.source === "native-cli" ? "CLI history, account unknown" : "Account " + (i + 1)} · ${p.window}`)}"><circle cx="${x(p.at)}" cy="${y(p.remaining)}" r="8" fill="transparent"/><title>${h.esc(stamp(p.at) + ": " + p.remaining.toFixed(1) + "% remaining")}</title></g>`,
          )
          .join("")
      );
    })
    .join("");
  const same = latest ? series.get(seriesKey(latest)) || [] : [],
    prev = [...same]
      .reverse()
      .find(
        (p) =>
          latest &&
          p.source === "provider" &&
          p.account === latest.account &&
          p.resetsAt !== null &&
          latest.resetsAt !== null &&
          Math.abs(Date.parse(p.resetsAt) - Date.parse(latest.resetsAt)) <
            60000 &&
          Date.parse(latest.at) - Date.parse(p.at) >= 15 * 60000,
      );
  const rate =
    latest && latest.source === "provider" && prev
      ? Math.max(
          0,
          (prev.remaining - latest.remaining) /
            ((Date.parse(latest.at) - Date.parse(prev.at)) / 3600000),
        )
      : null;
  return `<section class="panel quota-graph"><h2>${name} weekly limit</h2><div class="graph-number">${latest ? latest.remaining.toFixed(1) + "%" : "—"}<small>remaining</small></div><p class="graph-caption">${rate === null ? "Collecting burn rate" : rate.toFixed(1) + " percentage points / hour"}${latest?.resetsAt ? " · resets " + h.esc(stamp(latest.resetsAt)) : ""}</p><p class="graph-coverage">${refreshErrors ? "Refresh unavailable · showing saved data" : latest && samples.every((p) => p.remaining === 0) ? "Earlier depletion not recorded" : ""}</p><div class="chart-wrap"><svg viewBox="0 0 360 205" role="img" aria-label="${name} weekly quota remaining over time">${[0, 50, 100].map((v) => `<line class="grid" x1="42" x2="342" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="35" y="${y(v) + 4}" text-anchor="end">${v}%</text>`).join("")}${lines}<text class="axis" x="42" y="199">${h.esc(stamp(new Date(start).toISOString()))}</text><text class="axis" x="342" y="199" text-anchor="end">Now</text></svg><div class="chart-tip" hidden></div>${!samples.length ? '<p class="chart-empty">No retained quota snapshots for this range. New observations are collected automatically.</p>' : ""}</div><details data-usage-detail="quota-${provider}"><summary>Quota history</summary><p class="fine">${samples.length} observations${samples.length ? " · history begins " + h.esc(stamp(samples[0].at)) : ""}. ${refreshErrors ? "Quota refresh failed for " + refreshErrors + " account(s). " : ""}${samples.length && samples.every((p) => p.remaining === 0) ? "All saved observations in this range are at 0%. Earlier depletion cannot be reconstructed from tokens." : ""}</p><p class="fine">Provider observations, per account/window. Resets rise back toward 100% when reported. Lines connect saved readings using linear interpolation; intermediate percentages were not measured. Recovered CLI readings have unknown account identity and join the current account line for display only when there is one identified account. Different identified accounts remain separate.</p>${latest ? `<p class="fine">Last observed ${h.esc(stamp(latest.at))}</p>` : ""}</details></section>`;
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
  );
  return `<section class="panel daily-usage"><h2>Daily ${tokens ? "tokens" : "usage value"}</h2><div class="chart-wrap"><div class="daily-plot" role="img" aria-label="Daily ${tokens ? "tokens" : "API-equivalent value in USD"}"><div class="daily-axis">${[0, 0.5, 1].map((f) => `<span style="bottom:${f * 100}%">${tokens ? compact.format(max * f) : usd(max * f)}</span>`).join("")}</div><div class="daily-columns" style="grid-template-columns:repeat(${Math.max(1, list.length)},minmax(0,1fr))">${list
    .map(([day, d], i) => {
      const value = tokens ? d.tokens : d.value;
      return `<div class="daily-day trend-day" tabindex="0" data-tip="${h.esc(day + " · " + (tokens ? whole.format(value) + " tokens" : usd(value)) + (d.unpriced ? " · " + d.unpriced + " unpriced observations" : ""))}"><i style="height:${(100 * value) / max}%"></i>${i % Math.max(1, Math.ceil(list.length / 4)) === 0 && i < list.length - 1 ? `<span class="daily-date">${day.slice(5)}</span>` : ""}${i === list.length - 1 ? `<span class="daily-date last">${day.slice(5)}</span>` : ""}</div>`;
    })
    .join(
      "",
    )}</div></div><div class="chart-tip" hidden></div></div><select data-usage-field="metric" aria-label="Daily chart measure"><option value="value" ${!tokens ? "selected" : ""}>API-equivalent value</option><option value="tokens" ${tokens ? "selected" : ""}>Tokens</option></select><details data-usage-detail="daily-sources"><summary>Sources and gaps</summary><p class="fine">Recovered T3 usage uses retained rates or reported costs, not subscription charges. Missing rates are unpriced. Dates use UTC.</p></details></section>`;
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
    )}</div><div class="chart-wrap"><svg viewBox="0 0 600 190" role="img" aria-label="Distribution of tokens per T3 conversation">${bins.map((b, i) => `<g class="trend-day" tabindex="0" data-tip="${h.esc(whole.format(b.from) + "–" + whole.format(b.to) + " tokens · " + b.count + " conversations")}"><rect class="hit" x="${24 + i * 70}" y="12" width="66" height="145"/><rect x="${25 + i * 70}" y="${157 - (b.count / max) * 135}" width="62" height="${(b.count / max) * 135}" fill="var(--blue)" rx="3"/><text class="axis" x="${55 + i * 70}" y="177" text-anchor="middle">${compact.format(b.from)}</text><text class="axis" x="${55 + i * 70}" y="${149 - (b.count / max) * 135}" text-anchor="middle">${b.count || ""}</text></g>`).join("")}</svg><div class="chart-tip" hidden></div></div><details data-usage-detail="task-coverage"><summary>Statistics and coverage</summary><p class="fine">${s.count} mapped T3 conversations within the selected range. Population variance: ${whole.format(s.variance)} tokens². Standard deviation measures spread around the average. ${a.unassigned} usage observations could not be mapped to a T3 conversation and are excluded from task statistics. A conversation can be partial at range boundaries.</p></details></section>`;
}
export function topGraphs(report: Report, h: Helpers, view: UsageView) {
  return `<div class="usage-graphs">${quotaGraph("claude", report.quotaHistory || [], h, report.quotaRefreshErrors?.claude)}${quotaGraph("codex", report.quotaHistory || [], h, report.quotaRefreshErrors?.codex)}${dailyGraph(report, h, view)}</div>`;
}
function projectOverview(
  a: ReturnType<typeof taskAnalytics>,
  h: Helpers,
  metric: UsageView["projectMetric"],
) {
  const value = (p: (typeof a.projects)[number]) =>
    metric === "value" ? p.value : metric === "tasks" ? p.tasks : p.tokens;
  const format = metric === "value" ? usd : (n: number) => compact.format(n);
  const sorted = [...a.projects].sort((p, q) => value(q) - value(p));
  const total = sorted.reduce((n, p) => n + value(p), 0);
  const mean = sorted.length ? total / sorted.length : 0;
  const deviation = sorted.length
    ? Math.sqrt(
        sorted.reduce((n, p) => n + (value(p) - mean) ** 2, 0) / sorted.length,
      )
    : 0;
  const major = sorted.filter(
    (p, i) => i < 5 && total > 0 && value(p) / total >= 0.05,
  );
  const others = sorted.filter((p) => !major.includes(p));
  const otherTotal = others.reduce((n, p) => n + value(p), 0);
  const slices = [
    ...major.map((p) => ({ name: p.name, value: value(p) })),
    ...(otherTotal > 0 ? [{ name: "Other projects", value: otherTotal }] : []),
  ];
  const colors = [
    "var(--green)",
    "var(--blue)",
    "var(--series-claude)",
    "var(--yellow)",
    "var(--series-codex)",
    "var(--faint)",
  ];
  let offset = 0;
  const rings = slices
    .map((p, i) => {
      const length = total ? (p.value / total) * 100 : 0;
      const start = offset;
      offset += length;
      return `<circle class="trend-day" tabindex="0" data-tip="${h.esc(p.name + " · " + format(p.value) + " · " + length.toFixed(1) + "%")}" cx="100" cy="100" r="78" pathLength="100" fill="none" stroke="${colors[i]}" stroke-width="22" stroke-dasharray="${length} ${100 - length}" stroke-dashoffset="${-start}" transform="rotate(-90 100 100)"><title>${h.esc(p.name + ": " + format(p.value))}</title></circle>`;
    })
    .join("");
  const unpriced = a.projects.reduce((n, p) => n + p.unpriced, 0);
  const row = (p: (typeof a.projects)[number], color?: string) =>
    `<li><span class="project-name">${color ? `<i style="background:${color}"></i>` : ""}${h.esc(p.name)}</span><span>${metric === "value" && !p.value && p.unpriced ? "Unpriced" : format(value(p))}<small>${total ? ((100 * value(p)) / total).toFixed(1) + "%" : ""}${metric === "value" && p.unpriced ? " · incomplete value" : ""}</small></span></li>`;
  return `<section class="panel project-overview"><div class="project-heading"><h2>Projects</h2><select data-usage-field="projectMetric" aria-label="Project chart measure">${(
    [
      ["tokens", "Tokens"],
      ["value", "API-equivalent value"],
      ["tasks", "Conversations"],
    ] as const
  )
    .map(
      ([key, label]) =>
        `<option value="${key}" ${key === metric ? "selected" : ""}>${label}</option>`,
    )
    .join("")}</select></div><div class="task-stats">${[
    ["Total", format(total)],
    ["Average / project", format(mean)],
    ["Highest", format(sorted[0] ? value(sorted[0]) : 0)],
    ["Std. deviation", format(deviation)],
  ]
    .map(
      ([label, n]) =>
        `<div><span>${label}</span><strong>${sorted.length ? n : "—"}</strong></div>`,
    )
    .join(
      "",
    )}</div>${sorted.length ? `<div class="project-mix"><div class="chart-wrap"><svg viewBox="0 0 200 200" role="img" aria-label="Project contribution by ${metric}"><circle cx="100" cy="100" r="78" fill="none" stroke="var(--line)" stroke-width="22"/>${rings}<text class="project-count" x="100" y="100" text-anchor="middle">${sorted.length}</text><text class="axis" x="100" y="120" text-anchor="middle">projects</text></svg><div class="chart-tip" hidden></div></div><div><ul class="project-list">${major.map((p, i) => row(p, colors[i])).join("")}</ul>${others.length ? `<details class="project-others" data-usage-detail="other-projects"><summary>Other projects <span>${others.length} · ${format(otherTotal)}</span></summary><ul class="project-list">${others.map((p) => row(p)).join("")}</ul></details>` : ""}</div></div>` : '<p class="chart-empty">No project observations for these filters.</p>'}${metric === "value" ? `<p class="fine">API-equivalent estimate · ${unpriced ? whole.format(unpriced) + " unpriced observations excluded from value" : "USD"}</p>` : ""}</section>`;
}
export function projectGraphs(
  report: Report,
  h: Helpers,
  view: Pick<UsageView, "projectMetric"> = { projectMetric: "tokens" },
) {
  const activity = report.activity || [],
    a = taskAnalytics(activity);
  return `<details class="analytics-section" data-usage-detail="analytics" open><summary>Projects & conversations <span class="tag">Read-only T3 history</span></summary>${distribution(activity, h)}${projectOverview(a, h, view.projectMetric)}<div class="analytics-grid">${bars(
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
