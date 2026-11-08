import test from "node:test";
import assert from "node:assert/strict";
import { topGraphs, projectGraphs } from "../public/usage-graphs.ts";
import { usageView } from "../public/usage.ts";
import { buildReport } from "../src/usage-report.ts";
import type { Report, Helpers } from "../public/usage.ts";
const helpers: Helpers = {
  esc: (v) =>
    String(v)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll('"', "&quot;"),
  mark: String,
  pName: String,
  mask: String,
  heading: String,
};
const report: Report = {
  ...buildReport([]),
  generatedAt: "2026-11-08",
  coverage: {
    trackingStartedAt: null,
    firstExecutionAt: null,
    lastExecutionAt: null,
    writers: [],
    events: [],
    counters: {},
    gatewayRequests: [],
    ingest: {
      lastSuccessAt: null,
      lastError: null,
      backlogBytes: 0,
      outboxDir: "",
    },
    plugin: { known: false, loaded: false, detail: "" },
    attributionEnabled: false,
  },
  spending: { totals: {}, records: [], imports: [] },
  options: { accounts: [], models: [], devices: [], deviceLabels: [] },
};
test("usage starts with three charts and exposes conversation distribution and coverage without invented quota", () => {
  const charts = topGraphs(report, helpers, usageView);
  assert.equal((charts.match(/<section /g) || []).length, 3);
  assert.match(charts, /No retained quota snapshots/);
  const tasks = projectGraphs(report, helpers);
  for (const label of [
    "Average",
    "Median",
    "Lowest",
    "Highest",
    "Range",
    "Std. deviation",
    "Variance",
    "Conversations",
  ])
    assert.ok(tasks.includes(label));
  assert.match(tasks, /excluded from task statistics/);
  assert.doesNotMatch(tasks, /NaN|Infinity/);
});

test("project overview groups the long tail without losing projects or treating unpriced usage as free", () => {
  const activity = [50, 20, 10, 8, 7, 3, 2].map((n, i) => ({
    id: String(i),
    project: "Project " + i,
    task: "t" + i,
    estimatedUsd: i === 6 ? null : n,
    group: {
      day: "2026-11-08",
      provider: "codex",
      model: "test",
      tier: "standard",
      context: "standard" as const,
      usageStatus: "estimated" as const,
      account: null,
      device: null,
      principal: "t3-cache",
      classified: true,
      outcome: "unknown",
      executions: 1,
      tokens: {
        inputUncached: n,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        total: n,
      },
    },
  }));
  const output = projectGraphs({ ...report, activity }, helpers);
  const overview = output
    .split('<section class="panel project-overview">')[1]
    .split('<div class="analytics-grid">')[0];
  assert.ok(!overview.includes("metric-track"));
  assert.match(overview, /Other projects/);
  const others = overview.split('data-usage-detail="other-projects"')[1];
  assert.match(others, /Project 5/);
  assert.match(others, /Project 6/);
  assert.doesNotMatch(others, /Project 0/);
  assert.match(overview, /Average \/ project/);
  const values = projectGraphs({ ...report, activity }, helpers, {
    projectMetric: "value",
  });
  assert.match(values, /Unpriced/);
});
test("quota charts connect saved readings without visible markers and identify interpolation", () => {
  const at = (m: number) =>
    new Date(Date.parse("2026-11-08T00:00:00Z") + m * 60000).toISOString();
  const samples = [0, 5, 30].map((m, i) => ({
    provider: "codex",
    account: "unknown",
    window: "weekly",
    at: at(m),
    remaining: 90 - i * 10,
    resetsAt: at(10000),
    source: "native-cli" as const,
  }));
  const chart = topGraphs(
    { ...report, quotaHistory: samples },
    helpers,
    usageView,
  );
  const paths = [...chart.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]);
  assert.equal((paths[0].match(/L/g) || []).length, 2);
  assert.match(chart, /linear interpolation/);
  assert.doesNotMatch(chart, /r="3" fill="var/);
  const live = topGraphs(
    {
      ...report,
      quotaHistory: samples.map((s) => ({ ...s, source: "provider" as const })),
    },
    helpers,
    usageView,
  );
  const line = [...live.matchAll(/<path d="([^"]*)"/g)][0][1];
  assert.equal((line.match(/L/g) || []).length, 2);
  assert.equal((line.match(/M/g) || []).length, 1);
  assert.match(
    topGraphs(
      { ...report, quotaRefreshErrors: { claude: 1 } },
      helpers,
      usageView,
    ),
    /Refresh unavailable/,
  );
});

test("historical weekly readings join a sole live account, while different identified accounts stay separate", () => {
  const sample = {
    provider: "codex",
    account: "old",
    window: "weekly",
    at: "2026-10-24T00:00:00Z",
    remaining: 80,
    resetsAt: null,
    source: "native-cli" as const,
  };
  const live = {
    ...sample,
    account: "a",
    window: "secondary_window",
    at: "2026-11-08T00:00:00Z",
    remaining: 100,
    source: "provider" as const,
  };
  const one = topGraphs(
    { ...report, quotaHistory: [sample, live] },
    helpers,
    usageView,
  );
  assert.equal((one.match(/<path /g) || []).length, 1);
  assert.equal(
    (one.match(/<path d="([^"]*)"/)![1].match(/L/g) || []).length,
    1,
  );
  const multiple = topGraphs(
    {
      ...report,
      quotaHistory: [sample, live, { ...live, account: "b", remaining: 50 }],
    },
    helpers,
    usageView,
  );
  assert.equal((multiple.match(/<path /g) || []).length, 3);
});
