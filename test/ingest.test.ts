import { test } from "node:test";
import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeIngest } from "../src/ingest.ts";
import {
  Ledger,
  LedgerError,
  makeLedger,
  openDatabase,
} from "../src/ledger.ts";
import type { LedgerService } from "../src/ledger.ts";

const writerStart = (writer: string, at: string) => ({
  v: 1,
  type: "segment-start",
  at,
  writer,
  writer_started_at: at,
  segment: 1,
  plugin_version: "1.0.0",
});
const usage = (id: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  type: "usage",
  recorded_at: "2026-11-08T10:00:01Z",
  execution_id: id,
  trace_id: "trace-1",
  provider: "claude",
  model: "claude-opus-5-5",
  response_model: "claude-opus-5-5",
  auth_id: "claude-a.json",
  principal: "device:laptop-1",
  requested_at: "2026-11-08T10:00:00Z",
  latency_ms: 900,
  ttft_ms: 100,
  stream: true,
  generate: true,
  failed: false,
  tokens: {
    input: 100,
    output: 20,
    reasoning: 0,
    cached: 400,
    cache_read: 400,
    cache_creation: 50,
    total: 570,
  },
  ...extra,
});
const lines = (...values: unknown[]) =>
  values.map((v) => `${JSON.stringify(v)}\n`).join("");

function fixture(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "cli-proxy-ingest-"));
  const outbox = join(dir, "usage-outbox");
  mkdirSync(outbox);
  const dbPath = join(dir, "accounting.sqlite");
  const open: Array<{ close: () => void }> = [];
  t.after(() => {
    for (const db of open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ledger = (wrap: (l: LedgerService) => LedgerService = (l) => l) => {
    const db = openDatabase(dbPath);
    open.push(db);
    return wrap(makeLedger(db));
  };
  const run = (service: LedgerService) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* makeIngest(outbox);
        yield* ingest.runOnce;
        return {
          status: yield* ingest.status,
          coverage: yield* service.coverage,
          groups: yield* service.groups({}),
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, Layer.succeed(Ledger, service)),
        ),
      ),
    );
  return { outbox, ledger, run };
}

test("ingestion persists across restarts, ignores repeated delivery, and keeps distinct retries", async (t) => {
  const { outbox, ledger, run } = fixture(t);
  const segment = join(outbox, "20261108T100000Z-aaaa-0001.jsonl");
  writeFileSync(
    segment,
    lines(writerStart("aaaa", "2026-11-08T09:00:00Z"), usage("exec-1")),
  );
  const first = await run(ledger());
  assert.equal(first.status.lastError, null);
  assert.equal(first.status.ingested, 1);

  // A retry is a new execution with the same parent request; a repeated
  // delivery of exec-1 is the same execution and must not count twice.
  appendFileSync(
    segment,
    lines(
      usage("exec-1"),
      usage("exec-2", {
        failed: true,
        status_code: 429,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cached: 0,
          cache_read: 0,
          cache_creation: 0,
          total: 0,
        },
      }),
    ),
  );
  const second = await run(ledger());
  const executions = second.groups.reduce(
    (n, g) => n + Number(g.executions),
    0,
  );
  assert.equal(executions, 2);
  assert.equal(second.coverage.counters.duplicate_deliveries, 1);
  const total = second.groups.reduce((n, g) => n + Number(g.total ?? 0), 0);
  assert.equal(total, 570);
  const rejected = second.groups.find((g) => g.outcome === "rejected");
  assert.equal(rejected?.usageStatus, "unknown");

  // Reopening reads committed offsets: nothing is re-counted.
  const third = await run(ledger());
  assert.equal(third.status.ingested, 0);
  assert.equal(third.coverage.counters.duplicate_deliveries, 1);
});

test("a storage failure leaves offsets uncommitted so the next run recovers every record", async (t) => {
  const { outbox, ledger, run } = fixture(t);
  writeFileSync(
    join(outbox, "20261108T100000Z-bbbb-0001.jsonl"),
    lines(
      writerStart("bbbb", "2026-11-08T09:00:00Z"),
      usage("exec-a"),
      usage("exec-b"),
    ),
  );
  const failing = await run(
    ledger((l) => ({
      ...l,
      ingest: () => Effect.fail(new LedgerError({ message: "disk full" })),
    })),
  );
  assert.match(failing.status.lastError ?? "", /disk full/);
  const recovered = await run(ledger());
  assert.equal(recovered.status.lastError, null);
  assert.equal(
    recovered.groups.reduce((n, g) => n + Number(g.executions), 0),
    2,
  );
  assert.equal(recovered.coverage.counters.duplicate_deliveries ?? 0, 0);
});

test("unclean engine stops, torn lines, and plugin loss markers become coverage gaps", async (t) => {
  const { outbox, ledger, run } = fixture(t);
  // Writer cccc crashed mid-line and never wrote a final segment-end.
  writeFileSync(
    join(outbox, "20261108T090000Z-cccc-0001.jsonl"),
    lines(writerStart("cccc", "2026-11-08T09:00:00Z"), usage("exec-1")) +
      '{"v":1,"type":"us',
  );
  await run(ledger());
  // A new engine process starts; the earlier one is now known to have stopped.
  writeFileSync(
    join(outbox, "20261108T110000Z-dddd-0001.jsonl"),
    lines(
      writerStart("dddd", "2026-11-08T11:00:00Z"),
      {
        v: 1,
        type: "write-failures",
        at: "2026-11-08T11:05:00Z",
        writer: "dddd",
        writer_started_at: "2026-11-08T11:00:00Z",
        failed_writes: 2,
        dropped: 1,
        dropped_ids: ["lost-1"],
      },
      {
        v: 1,
        type: "segment-end",
        at: "2026-11-08T12:00:00Z",
        writer: "dddd",
        writer_started_at: "2026-11-08T11:00:00Z",
        final: true,
        pending: 1,
        pending_ids: ["lost-2"],
      },
      "not json at all",
    ).replace('"not json at all"', "not json at all"),
  );
  await run(ledger());
  const final = await run(ledger());
  const kinds = final.coverage.events.map((e) => String(e.kind)).sort();
  assert.deepEqual(kinds, [
    "dropped",
    "lost-at-shutdown",
    "storage-retry",
    "torn-record",
    "unclean-stop",
  ]);
  assert.equal(final.coverage.counters.invalid_outbox_lines, 1);
  const writers = final.coverage.writers.map((w) => [
    w.writer,
    w.ended_at !== null,
  ]);
  assert.deepEqual(writers, [
    ["cccc", true],
    ["dddd", true],
  ]);
  assert.equal(final.status.backlogBytes, 0);
  assert.match(
    String(final.coverage.events.find((e) => e.kind === "dropped")?.detail),
    /lost-1/,
  );
});

test("an engine killed and restarted within one second is still detected", async (t) => {
  const { outbox, ledger, run } = fixture(t);
  // Same-second segment names sort by writer ID, opposite to start order here.
  writeFileSync(
    join(outbox, "20261108T100000Z-ffff-0001.jsonl"),
    lines(writerStart("ffff", "2026-11-08T10:00:00.100Z"), usage("exec-1")),
  );
  writeFileSync(
    join(outbox, "20261108T100000Z-0000-0001.jsonl"),
    lines(writerStart("0000", "2026-11-08T10:00:00.900Z")),
  );
  const result = await run(ledger());
  const unclean = result.coverage.events.filter(
    (e) => e.kind === "unclean-stop",
  );
  assert.deepEqual(
    unclean.map((e) => e.writer),
    ["ffff"],
  );
  const open = result.coverage.writers
    .filter((w) => w.ended_at === null)
    .map((w) => w.writer);
  assert.deepEqual(open, ["0000"]);
});
