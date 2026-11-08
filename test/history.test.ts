import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { collectT3History } from "../src/t3-history.ts";
import { insertHistory, readHistory } from "../src/quota-history.ts";
import { taskAnalytics } from "../src/task-analytics.ts";
import type { NativeUsage } from "../src/quota-history.ts";

async function fixture(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(join(tmpdir(), "proxy-history-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("T3 cache import reads normalized usage, deduplicates copied Claude messages, joins whole T3 conversations and leaves sources unchanged", async (t) => {
  const dir = await fixture(t),
    path = join(dir, "statev2.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE projection_projects(project_id TEXT,title TEXT,workspace_root TEXT);CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,payload_json TEXT);CREATE TABLE orchestration_v2_projection_provider_threads(payload_json TEXT)",
  );
  db.prepare("INSERT INTO projection_projects VALUES (?,?,?)").run(
    "p",
    "CLI Proxy",
    "/projects/proxy",
  );
  db.prepare(
    "INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?)",
  ).run("thread-1", "p", "Fix gateway", "{}");
  db.prepare(
    "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?)",
  ).run(
    JSON.stringify({
      appThreadId: "thread-1",
      nativeThreadRef: { nativeId: "native-parent" },
    }),
  );
  db.close();
  const row = [
    Date.parse("2026-10-15T10:00:00Z"),
    0,
    0,
    100,
    20,
    0,
    4,
    1,
    "message-id",
    null,
    0,
    null,
  ];
  const cache = {
    version: 11,
    models: ["claude-test"],
    sessions: ["native-parent"],
    files: {
      first: { p: "claude", r: [row], t: [] },
      copy: { p: "claude", r: [row], t: [] },
    },
  };
  const cachePath = join(dir, "usage-scan-cache-v11.json");
  await fs.writeFile(cachePath, JSON.stringify(cache));
  await fs.writeFile(
    join(dir, "usage-model-rates.json"),
    JSON.stringify({
      fetchedAtMs: Date.parse("2026-11-01"),
      document: {
        "claude-test": {
          input_cost_per_token: 1e-6,
          output_cost_per_token: 5e-6,
          cache_read_input_token_cost: 1e-7,
        },
      },
    }),
  );
  const beforeDB = await fs.readFile(path),
    beforeCache = await fs.readFile(cachePath);
  const history = await collectT3History(dir, "2026-10");
  assert.equal(history.usage.length, 1);
  const u = history.usage[0];
  assert.equal(u.project, "CLI Proxy");
  assert.equal(u.task, "thread-1");
  assert.equal(u.group.tokens.total, 124);
  assert.ok(Math.abs((u.estimatedUsd || 0) - 0.000122) < 1e-12);
  assert.equal(u.priceBasis, "t3-rate-snapshot");
  assert.deepEqual(await fs.readFile(path), beforeDB);
  assert.deepEqual(await fs.readFile(cachePath), beforeCache);
  const data = join(dir, "app-data");
  assert.equal(insertHistory(data, history).usage, 1);
  assert.equal(insertHistory(data, history).usage, 0);
  assert.equal(readHistory(data).activity.length, 1);
});
test("token distribution groups whole conversations, excludes unassigned sessions and does not count reasoning twice", () => {
  const rows: NativeUsage[] = [10, 20, 30].map((total, i) => ({
    id: String(i),
    task: "task-" + i,
    project: "Project",
    estimatedUsd: i,
    group: {
      day: "2026-10-15",
      provider: "codex",
      model: "test",
      tier: "standard",
      context: "standard",
      usageStatus: "estimated",
      account: null,
      device: null,
      principal: "t3-cache",
      classified: true,
      outcome: "unknown",
      executions: 1,
      tokens: {
        inputUncached: total - 2,
        cacheRead: 0,
        cacheWrite: 0,
        output: 2,
        reasoning: 1,
        total,
      },
    },
  }));
  const a = taskAnalytics(rows);
  assert.equal(a.stats.mean, 20);
  assert.equal(a.stats.median, 20);
  assert.equal(a.stats.min, 10);
  assert.equal(a.stats.max, 30);
  assert.ok(Math.abs(a.stats.variance - 200 / 3) < 1e-9);
  assert.equal(a.projects[0].tasks, 3);
  const unassigned = { ...rows[0], id: "unknown", task: "native:unknown" };
  assert.equal(taskAnalytics([...rows, unassigned]).stats.count, 3);
  assert.equal(
    taskAnalytics([...rows, { ...rows[0], id: "second-turn" }]).stats.count,
    3,
  );
});
test("quota snapshots preserve real resets, gaps and unknown data without inventing usage", async (t) => {
  const dir = await fixture(t);
  const history = {
    version: 1 as const,
    month: "2026-10",
    usage: [],
    quota: [
      {
        account: "a",
        provider: "codex",
        window: "weekly",
        at: "2026-10-15T00:00:00Z",
        remaining: 5,
        resetsAt: "2026-10-16T00:00:00Z",
        source: "provider" as const,
      },
      {
        account: "a",
        provider: "codex",
        window: "weekly",
        at: "2026-10-16T00:01:00Z",
        remaining: 100,
        resetsAt: "2026-10-23T00:00:00Z",
        source: "provider" as const,
      },
    ],
  };
  insertHistory(dir, history);
  insertHistory(dir, history);
  assert.deepEqual(
    readHistory(dir).quota.map((s) => s.remaining),
    [5, 100],
  );
  assert.equal(readHistory(dir, { from: "2026-11-01" }).quota.length, 0);
});

test("T3 retained pricing honors fast multipliers and cache ratios without guessing unknown models", async (t) => {
  const dir = await fixture(t);
  const row = (model: number, speed: number, key: string) => [
    Date.parse("2026-10-15"),
    model,
    0,
    100,
    20,
    0,
    4,
    1,
    key,
    null,
    speed,
    null,
  ];
  await fs.writeFile(
    join(dir, "usage-scan-cache-v11.json"),
    JSON.stringify({
      version: 11,
      models: ["fast-model", "priority-model", "missing"],
      sessions: ["s"],
      files: {
        first: {
          p: "claude",
          r: [row(0, 1, "a"), row(1, 1, "b"), row(2, 0, "c")],
        },
      },
    }),
  );
  const base = {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
  };
  await fs.writeFile(
    join(dir, "usage-model-rates.json"),
    JSON.stringify({
      document: {
        "fast-model": { ...base, provider_specific_entry: { fast: 2 } },
        "priority-model": {
          ...base,
          input_cost_per_token_priority: 2e-6,
          output_cost_per_token_priority: 10e-6,
        },
      },
    }),
  );
  const result = await collectT3History(dir, "all");
  for (const u of result.usage.slice(0, 2))
    assert.ok(Math.abs((u.estimatedUsd || 0) - 0.000244) < 1e-12);
  assert.equal(result.usage[2].estimatedUsd, null);
  assert.equal(taskAnalytics([]).stats.count, 0);
});
