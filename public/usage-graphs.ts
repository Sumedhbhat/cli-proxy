import type { Report, Helpers, UsageView } from "./usage.ts";
import type { QuotaSample } from "../src/quota-history.ts";
import { taskAnalytics, tokenBands } from "../src/task-analytics.ts";
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
const dayStamp = (day: string) =>
  new Date(day.slice(0, 10) + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
function quotaGraph(
  provider: string,
  all: QuotaSample[],
  h: Helpers,
  view: UsageView,
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
  const series = new Map<string, Map<string, QuotaSample>>();
  for (const s of samples) {
    const account =
      s.source === "native-cli" && accounts.length === 1
        ? accounts[0]
        : s.account;
    const window = /^(weekly|seven_day|secondary_window)$/.test(s.window)
      ? "weekly"
      : s.window;
    const key = account + ":" + window;
    const days = series.get(key) || new Map<string, QuotaSample>();
    days.set(s.at.slice(0, 10), s);
    series.set(key, days);
  }
  const today = new Date().toISOString().slice(0, 10),
    dayMs = 86400000;
  const from =
    view.range === "custom"
      ? view.from || samples[0]?.at.slice(0, 10) || today
      : view.range === "all"
        ? samples[0]?.at.slice(0, 10) || today
        : new Date(Date.parse(today) - ((Number(view.range) || 30) - 1) * dayMs)
            .toISOString()
            .slice(0, 10);
  const to = view.range === "custom" && view.to ? view.to : today;
  const start = Date.parse(from),
    end = Date.parse(to),
    span = Math.max(dayMs, end - start);
  const x = (day: string) =>
    42 + (300 * (Date.parse(day.slice(0, 10)) - start)) / span;
  const y = (n: number) => 174 - 1.4 * n;
  const dailyDays = new Set(samples.map((s) => s.at.slice(0, 10))).size;
  const lines = [...series.values()]
    .map((days, i) => {
      const points = [...days.values()];
      const path = points
        .map(
          (p, j) =>
            `${j === 0 ? "M" : "L"}${x(p.at).toFixed(1)},${y(p.remaining).toFixed(1)}`,
        )
        .join(" ");
      return (
        `<path d="${path}" fill="none" stroke="var(--series-${provider})" stroke-width="2.3" opacity="${Math.max(0.4, 1 - i * 0.12)}"/>` +
        points
          .map(
            (p) =>
              `<g class="trend-day" tabindex="0" data-tip="${h.esc(`${dayStamp(p.at)} · ${p.remaining.toFixed(1)}% remaining · last saved reading of the day${p.source === "native-cli" ? " · CLI history, account unknown" : ""}`)}"><circle cx="${x(p.at)}" cy="${y(p.remaining)}" r="8" fill="transparent"/><title>${h.esc(dayStamp(p.at) + ": " + p.remaining.toFixed(1) + "% remaining")}</title></g>`,
          )
          .join("")
      );
    })
    .join("");
  const ticks = Array.from(
    { length: Math.min(5, Math.max(2, Math.round((end - start) / dayMs) + 1)) },
    (_, i) => i,
  );
  const dateTicks = ticks
    .map((_, i) => {
      const f = i / (ticks.length - 1),
        day = new Date(start + Math.round((f * (end - start)) / dayMs) * dayMs)
          .toISOString()
          .slice(0, 10);
      return `<text class="axis" x="${42 + 300 * f}" y="199" text-anchor="${i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}">${h.esc(dayStamp(day))}</text>`;
    })
    .join("");
  return `<section class="panel quota-graph"><h2>${name} weekly limit</h2><div class="graph-number">${latest ? latest.remaining.toFixed(1) + "%" : "—"}<small>remaining</small></div><p class="graph-caption">Daily remaining${latest?.resetsAt ? " · resets " + h.esc(new Date(latest.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })) : ""}</p><p class="graph-coverage">${refreshErrors ? "Refresh unavailable · showing saved data" : latest && samples.every((p) => p.remaining === 0) ? "Earlier depletion not recorded" : ""}</p><div class="chart-wrap"><svg viewBox="0 0 360 205" role="img" aria-label="${name} daily quota remaining">${[0, 50, 100].map((v) => `<line class="grid" x1="42" x2="342" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="35" y="${y(v) + 4}" text-anchor="end">${v}%</text>`).join("")}${lines}${dateTicks}</svg><div class="chart-tip" hidden></div>${dailyDays < 2 ? `<p class="chart-empty">${dailyDays ? "One day recorded. A daily trend needs another day." : "No daily quota readings for this range yet."}</p>` : ""}</div><details data-usage-detail="quota-${provider}"><summary>Quota history</summary><p class="fine">${samples.length} saved observations across ${dailyDays} days. The line uses the last saved reading per UTC day, per account and window. Today's value can change while the day is in progress. Missing days have no measured value; lines between recorded days are linear interpolation. Recovered CLI readings have unknown account identity and join the sole identified account for display. Different identified accounts remain separate.</p>${latest ? `<p class="fine">Last observed ${h.esc(stamp(latest.at))}</p>` : ""}</details></section>`;
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
      .sort((a, b) => b.value - a.value),
    max = Math.max(1, ...sorted.map((r) => r.value));
  const renderRow = (r: (typeof rows)[number]) =>
    `<li><div><span title="${h.esc(r.name)}">${h.esc(r.name)}</span><strong>${format(r.value)}</strong></div><div class="metric-track"><i style="width:${(100 * r.value) / max}%"></i></div>${r.detail ? `<small>${h.esc(r.detail)}</small>` : ""}</li>`;
  return `<section class="panel analytics-bars"><h2>${h.esc(title)}</h2>${sorted.length ? `<ol>${sorted.slice(0, 5).map(renderRow).join("")}</ol>${sorted.length > 5 ? `<details class="ranking-more" data-usage-detail="ranking-${h.esc(title)}"><summary><span class="show-more">Show more</span><span class="show-less">Show less</span> <span class="fine">(${sorted.length - 5})</span></summary><ol start="6">${sorted.slice(5).map(renderRow).join("")}</ol></details>` : ""}` : '<p class="chart-empty">No attributed observations for these filters yet.</p>'}</section>`;
}
function distribution(activity: NonNullable<Report["activity"]>, h: Helpers) {
  const a = taskAnalytics(activity),
    s = a.stats;
  const bins = tokenBands(a.tasks.map((t) => t.tokens));
  const colors = [
    "var(--blue)",
    "var(--green)",
    "var(--series-claude)",
    "var(--yellow)",
    "var(--series-codex)",
    "var(--faint)",
  ];
  let offset = 0;
  const slices = bins
    .map((b, i) => {
      const share = s.count ? (100 * b.count) / s.count : 0,
        start = offset;
      offset += share;
      return share
        ? `<circle cx="100" cy="100" r="78" pathLength="100" fill="none" stroke="${colors[i]}" stroke-width="22" stroke-dasharray="${share} ${100 - share}" stroke-dashoffset="${-start}" transform="rotate(-90 100 100)"><title>${h.esc(b.label + ": " + b.count + " conversations")}</title></circle>`
        : "";
    })
    .join("");
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
    )}</div><div class="token-bands"><svg viewBox="0 0 200 200" role="img" aria-label="Conversations grouped by total tokens"><circle cx="100" cy="100" r="78" fill="none" stroke="var(--line)" stroke-width="22"/>${slices}<text class="project-count" x="100" y="100" text-anchor="middle">${s.count}</text><text class="axis" x="100" y="120" text-anchor="middle">conversations</text></svg><ul>${bins.map((b, i) => `<li><span><i style="background:${colors[i]}"></i>${h.esc(b.label)}</span><strong>${b.count}<small>${s.count ? ((100 * b.count) / s.count).toFixed(1) : "0"}%</small></strong></li>`).join("")}</ul></div><details data-usage-detail="task-coverage"><summary>Statistics and coverage</summary><p class="fine">${s.count} mapped T3 conversations within the selected range. Population variance: ${whole.format(s.variance)} tokens². Size bands show how many conversations fall in each token range, not how many tokens the whole band used. Lower boundaries are inclusive and upper boundaries exclusive. K means thousand and M means million. Standard deviation measures spread around the average. ${a.unassigned} usage observations could not be mapped to a T3 conversation and are excluded from task statistics. A conversation can be partial at range boundaries.</p></details></section>`;
}
export function topGraphs(report: Report, h: Helpers, view: UsageView) {
  return `<div class="usage-graphs">${quotaGraph("claude", report.quotaHistory || [], h, view, report.quotaRefreshErrors?.claude)}${quotaGraph("codex", report.quotaHistory || [], h, view, report.quotaRefreshErrors?.codex)}${dailyGraph(report, h, view)}</div>`;
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
