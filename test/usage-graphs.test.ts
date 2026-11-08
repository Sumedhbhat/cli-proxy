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
