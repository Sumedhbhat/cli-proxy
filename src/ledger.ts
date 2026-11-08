// The accounting database. The console is its only writer: the engine plugin
// writes the outbox, and ingestion copies sanitized records in here.
import { Context, Data, Effect, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AppConfig } from "./config.ts";
import type { Tokens, UsageStatus, Outcome } from "./accounting.ts";
import type { ContextBucket } from "./pricing.ts";

export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Ordered and append-only: a released migration is never edited.
export const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE executions (
    execution_id TEXT PRIMARY KEY,
    trace_id TEXT,
    selection_id TEXT,
    provider TEXT NOT NULL,
    executor TEXT,
    model TEXT,
    response_model TEXT,
    priced_model TEXT NOT NULL,
    account_id TEXT,
    auth_type TEXT,
    device_id TEXT,
    principal_kind TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    day TEXT NOT NULL,
    latency_ms INTEGER,
    ttft_ms INTEGER,
    stream INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    status_code INTEGER,
    service_tier TEXT NOT NULL,
    reasoning_effort TEXT,
    usage_status TEXT NOT NULL,
    usage_note TEXT,
    input_uncached INTEGER,
    cache_read INTEGER,
    cache_write INTEGER,
    output INTEGER,
    reasoning INTEGER,
    total INTEGER,
    context_bucket TEXT NOT NULL,
    raw_tokens TEXT NOT NULL,
    accounting_version INTEGER NOT NULL,
    source_segment TEXT NOT NULL,
    source_offset INTEGER NOT NULL,
    ingested_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX executions_day ON executions(day);
  CREATE INDEX executions_trace ON executions(trace_id);
  CREATE TABLE segments (
    name TEXT PRIMARY KEY,
    writer TEXT,
    offset INTEGER NOT NULL,
    ended INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  ) STRICT;
  CREATE TABLE writers (
    writer TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    plugin_version TEXT,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT
  ) STRICT;
  CREATE TABLE coverage_events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    writer TEXT,
    count INTEGER NOT NULL DEFAULT 0,
    detail TEXT
  ) STRICT;
  CREATE TABLE counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    key_sha256 TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;
  CREATE TABLE billing_imports (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    file_sha256 TEXT UNIQUE,
    coverage_start TEXT NOT NULL,
    coverage_end TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    row_count INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE billing_records (
    id INTEGER PRIMARY KEY,
    import_id INTEGER REFERENCES billing_imports(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    account TEXT,
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    occurred_on TEXT NOT NULL,
    period_start TEXT,
    period_end TEXT,
    description TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX billing_records_occurred ON billing_records(occurred_on);`,
  // The gateway's own count of inference requests. The engine does not record
  // some executions (for example Codex streams the client cancels); comparing
  // these counts with executions shows where that happened.
  `CREATE TABLE gateway_requests (
    day TEXT NOT NULL,
    provider TEXT NOT NULL,
    principal_kind TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL,
    status_class TEXT NOT NULL,
    client_closed INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (day, provider, principal_kind, device_id, transport, status_class, client_closed)
  ) STRICT;`,
];

export interface GatewayRequestCount {
  readonly day: string;
  readonly provider: string;
  readonly principalKind: string;
  readonly deviceId: string;
  readonly transport: "http" | "websocket";
  readonly statusClass: string;
  readonly clientClosed: boolean;
  readonly count: number;
}

export interface ExecutionRow {
  readonly executionId: string;
  readonly traceId: string | null;
  readonly selectionId: string | null;
  readonly provider: string;
  readonly executor: string | null;
  readonly model: string | null;
  readonly responseModel: string | null;
  readonly pricedModel: string;
  readonly accountId: string | null;
  readonly authType: string | null;
  readonly deviceId: string | null;
  readonly principalKind: string;
  readonly requestedAt: string;
  readonly recordedAt: string;
  readonly day: string;
  readonly latencyMs: number | null;
  readonly ttftMs: number | null;
  readonly stream: boolean;
  readonly outcome: Outcome;
  readonly statusCode: number | null;
  readonly serviceTier: string;
  readonly reasoningEffort: string | null;
  readonly usageStatus: UsageStatus;
  readonly usageNote: string | null;
  readonly tokens: Tokens;
  readonly contextBucket: ContextBucket;
  readonly rawTokens: string;
  readonly accountingVersion: number;
}

export interface CoverageEvent {
  readonly kind: string;
  readonly at: string;
  readonly writer: string | null;
  readonly count: number;
  readonly detail: string | null;
}

// One atomic unit of ingestion: everything read from a segment up to `offset`.
export interface IngestBatch {
  readonly segment: string;
  readonly offset: number;
  readonly ended: boolean;
  readonly writer: {
    readonly id: string;
    readonly startedAt: string;
    readonly pluginVersion: string | null;
  } | null;
  readonly writerEndedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly executions: ReadonlyArray<
    ExecutionRow & { readonly offset: number }
  >;
  readonly coverage: ReadonlyArray<CoverageEvent>;
  readonly invalidLines: number;
}

export interface Filter {
  readonly from?: string; // inclusive UTC day
  readonly to?: string; // inclusive UTC day
  readonly provider?: string;
  readonly account?: string;
  readonly device?: string; // device id, or "shared-key", "unattributed"
  readonly model?: string;
}

export interface BillingInput {
  readonly kind: string;
  readonly provider: string;
  readonly account: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly occurredOn: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly description: string | null;
}

type Row = Record<string, SQLInputValue>;

export const openDatabase = (path: string) => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  // FULL fsyncs each commit, so an acknowledged ingestion survives power loss.
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number(row.version)),
  );
  const newest = Math.max(0, ...applied);
  if (newest > MIGRATIONS.length) {
    db.close();
    throw new Error(
      `Accounting database schema ${newest} is newer than this console`,
    );
  }
  MIGRATIONS.forEach((sql, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  return db;
};

const filterSQL = (filter: Filter, alias = "") => {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  const column = (name: string) => `${alias}${name}`;
  if (filter.from)
    (clauses.push(`${column("day")} >= ?`), params.push(filter.from));
  if (filter.to)
    (clauses.push(`${column("day")} <= ?`), params.push(filter.to));
  if (filter.provider)
    (clauses.push(`${column("provider")} = ?`), params.push(filter.provider));
  if (filter.account)
    (clauses.push(`${column("account_id")} = ?`), params.push(filter.account));
  if (filter.model)
    (clauses.push(`${column("priced_model")} = ?`), params.push(filter.model));
  if (filter.device === "shared-key")
    clauses.push(`${column("principal_kind")} = 'shared-key'`);
  else if (filter.device === "unattributed")
    clauses.push(`${column("principal_kind")} NOT IN ('device', 'shared-key')`);
  else if (filter.device)
    (clauses.push(`${column("device_id")} = ?`), params.push(filter.device));
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
};

export const makeLedger = (db: DatabaseSync) => {
  const run = <A>(label: string, f: () => A) =>
    Effect.try({
      try: f,
      catch: (cause) =>
        new LedgerError({
          message: `Accounting database ${label} failed`,
          cause,
        }),
    });
  const transaction = <A>(label: string, f: () => A) =>
    run(label, () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = f();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  const bump = db.prepare(
    "INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value",
  );
  const insertExecution = db.prepare(`INSERT OR IGNORE INTO executions (
      execution_id, trace_id, selection_id, provider, executor, model, response_model, priced_model,
      account_id, auth_type, device_id, principal_kind, requested_at, recorded_at, day, latency_ms,
      ttft_ms, stream, outcome, status_code, service_tier, reasoning_effort, usage_status, usage_note,
      input_uncached, cache_read, cache_write, output, reasoning, total, context_bucket, raw_tokens,
      accounting_version, source_segment, source_offset, ingested_at
    ) VALUES (${Array(36).fill("?").join(", ")})`);

  const ingest = (batch: IngestBatch) =>
    transaction("ingest", () => {
      const now = new Date().toISOString();
      let inserted = 0;
      let duplicates = 0;
      if (batch.writer)
        db.prepare(
          `INSERT INTO writers (writer, started_at, plugin_version, last_seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(writer) DO NOTHING`,
        ).run(
          batch.writer.id,
          batch.writer.startedAt,
          batch.writer.pluginVersion,
          batch.writer.startedAt,
        );
      for (const row of batch.executions) {
        const t = row.tokens;
        const result = insertExecution.run(
          row.executionId,
          row.traceId,
          row.selectionId,
          row.provider,
          row.executor,
          row.model,
          row.responseModel,
          row.pricedModel,
          row.accountId,
          row.authType,
          row.deviceId,
          row.principalKind,
          row.requestedAt,
          row.recordedAt,
          row.day,
          row.latencyMs,
          row.ttftMs,
          row.stream ? 1 : 0,
          row.outcome,
          row.statusCode,
          row.serviceTier,
          row.reasoningEffort,
          row.usageStatus,
          row.usageNote,
          t.inputUncached,
          t.cacheRead,
          t.cacheWrite,
          t.output,
          t.reasoning,
          t.total,
          row.contextBucket,
          row.rawTokens,
          row.accountingVersion,
          batch.segment,
          row.offset,
          now,
        );
        if (result.changes > 0) inserted++;
        else duplicates++;
      }
      for (const event of batch.coverage)
        db.prepare(
          "INSERT INTO coverage_events (kind, at, writer, count, detail) VALUES (?, ?, ?, ?, ?)",
        ).run(event.kind, event.at, event.writer, event.count, event.detail);
      const writerId =
        batch.writer?.id ??
        (db
          .prepare("SELECT writer FROM segments WHERE name = ?")
          .get(batch.segment)?.writer as string | undefined);
      if (writerId && batch.lastSeenAt)
        db.prepare(
          "UPDATE writers SET last_seen_at = max(last_seen_at, ?) WHERE writer = ?",
        ).run(batch.lastSeenAt, writerId);
      if (writerId && batch.writerEndedAt)
        db.prepare("UPDATE writers SET ended_at = ? WHERE writer = ?").run(
          batch.writerEndedAt,
          writerId,
        );
      db.prepare(
        `INSERT INTO segments (name, writer, offset, ended, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET offset = excluded.offset, ended = max(ended, excluded.ended),
           writer = coalesce(segments.writer, excluded.writer), updated_at = excluded.updated_at`,
      ).run(
        batch.segment,
        writerId ?? null,
        batch.offset,
        batch.ended ? 1 : 0,
        now,
        now,
      );
      if (duplicates) bump.run("duplicate_deliveries", duplicates);
      if (batch.invalidLines)
        bump.run("invalid_outbox_lines", batch.invalidLines);
      return { inserted, duplicates };
    });

  const segments = run(
    "read segments",
    () =>
      new Map(
        db
          .prepare("SELECT name, offset, ended, deleted_at FROM segments")
          .all()
          .map((row) => [
            String(row.name),
            {
              offset: Number(row.offset),
              ended: Number(row.ended) === 1,
              deleted: row.deleted_at !== null,
            },
          ]),
      ),
  );
  const markDeleted = (name: string) =>
    run("mark segment", () => {
      db.prepare("UPDATE segments SET deleted_at = ? WHERE name = ?").run(
        new Date().toISOString(),
        name,
      );
    });
  // Called after every segment on disk has been read, so any clean final
  // marker has already been ingested. A writer still open while a later engine
  // process has started crashed or was killed: executions still queued inside
  // the engine at that moment cannot be accounted for.
  const closeSupersededWriters = transaction("close writers", () => {
    const stale = db
      .prepare(
        `SELECT w.writer, w.last_seen_at,
           (SELECT min(n.started_at) FROM writers n WHERE n.started_at > w.started_at) AS next_start
         FROM writers w
         WHERE w.ended_at IS NULL
           AND EXISTS (SELECT 1 FROM writers n WHERE n.started_at > w.started_at)`,
      )
      .all();
    for (const previous of stale) {
      db.prepare(
        "INSERT INTO coverage_events (kind, at, writer, count, detail) VALUES (?, ?, ?, 0, ?)",
      ).run(
        "unclean-stop",
        String(previous.last_seen_at),
        String(previous.writer),
        `Engine stopped without a clean shutdown between ${previous.last_seen_at} and ${previous.next_start}. Executions still queued inside the engine at that moment may be missing.`,
      );
      db.prepare(
        "UPDATE writers SET ended_at = last_seen_at WHERE writer = ?",
      ).run(String(previous.writer));
    }
    return stale.length;
  });
  // Unfinished segments of writers that have stopped; no more lines will come.
  const orphanedSegments = run(
    "lookup segments",
    () =>
      new Set(
        db
          .prepare(
            `SELECT s.name FROM segments s JOIN writers w ON w.writer = s.writer
           WHERE s.ended = 0 AND s.deleted_at IS NULL AND w.ended_at IS NOT NULL`,
          )
          .all()
          .map((row) => String(row.name)),
      ),
  );

  // Groups with identical pricing inputs; tokens sum exactly within a group.
  const groups = (filter: Filter) =>
    run("summarize", () => {
      const { where, params } = filterSQL(filter);
      return db
        .prepare(
          `SELECT day, provider, priced_model AS model, service_tier AS tier, context_bucket AS context,
             usage_status AS usageStatus, account_id AS account, device_id AS device, principal_kind AS principal,
             (input_uncached IS NOT NULL) AS classified, outcome,
             count(*) AS executions, sum(input_uncached) AS inputUncached, sum(cache_read) AS cacheRead,
             sum(cache_write) AS cacheWrite, sum(output) AS output, sum(reasoning) AS reasoning,
             sum(total) AS total
           FROM executions ${where}
           GROUP BY day, provider, priced_model, service_tier, context_bucket, usage_status, account_id,
             device_id, principal_kind, classified, outcome
           ORDER BY day`,
        )
        .all(...params) as Row[];
    });
  // Keyset pages keep exports bounded in memory and the event loop responsive.
  const rows = (
    filter: Filter,
    after: readonly [string, string] | null,
    limit: number,
  ) =>
    run("export", () => {
      const { where, params } = filterSQL(filter);
      const page = after
        ? `${where ? `${where} AND` : "WHERE"} (requested_at, execution_id) > (?, ?)`
        : where;
      return db
        .prepare(
          `SELECT execution_id, trace_id, selection_id, requested_at, day, provider, executor, model,
             response_model, priced_model, account_id, auth_type, device_id, principal_kind, outcome,
             status_code, stream, service_tier, reasoning_effort, usage_status, usage_note,
             input_uncached, cache_read, cache_write, output, reasoning, total, context_bucket,
             latency_ms, ttft_ms, accounting_version
           FROM executions ${page} ORDER BY requested_at, execution_id LIMIT ?`,
        )
        .all(...params, ...(after ?? []), limit) as Row[];
    });
  const coverage = run("coverage", () => ({
    trackingStartedAt:
      db.prepare("SELECT min(started_at) AS at FROM writers").get()?.at ?? null,
    firstExecutionAt:
      db.prepare("SELECT min(requested_at) AS at FROM executions").get()?.at ??
      null,
    lastExecutionAt:
      db.prepare("SELECT max(requested_at) AS at FROM executions").get()?.at ??
      null,
    writers: db
      .prepare(
        "SELECT writer, started_at, plugin_version, last_seen_at, ended_at FROM writers ORDER BY started_at",
      )
      .all() as Row[],
    events: db
      .prepare(
        "SELECT kind, at, writer, count, detail FROM coverage_events ORDER BY at DESC LIMIT 200",
      )
      .all() as Row[],
    counters: Object.fromEntries(
      db
        .prepare("SELECT name, value FROM counters")
        .all()
        .map((row) => [String(row.name), Number(row.value)]),
    ),
  }));
  const options = run("options", () => ({
    accounts: db
      .prepare(
        "SELECT DISTINCT provider, account_id AS id FROM executions WHERE account_id IS NOT NULL ORDER BY provider, account_id",
      )
      .all() as Row[],
    models: db
      .prepare(
        "SELECT DISTINCT provider, priced_model AS id FROM executions ORDER BY provider, priced_model",
      )
      .all() as Row[],
    devices: db
      .prepare(
        "SELECT DISTINCT device_id AS id FROM executions WHERE device_id IS NOT NULL ORDER BY device_id",
      )
      .all() as Row[],
  }));

  const devices = run(
    "list devices",
    () =>
      db
        .prepare(
          "SELECT id, label, key_sha256, created_at, revoked_at FROM devices ORDER BY created_at",
        )
        .all() as Row[],
  );
  const addDevice = (id: string, label: string, keySha256: string) =>
    run("add device", () => {
      db.prepare(
        "INSERT INTO devices (id, label, key_sha256, created_at) VALUES (?, ?, ?, ?)",
      ).run(id, label, keySha256, new Date().toISOString());
    });
  const revokeDevice = (id: string) =>
    run(
      "revoke device",
      () =>
        db
          .prepare(
            "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
          )
          .run(new Date().toISOString(), id).changes > 0,
    );

  const addBilling = (
    records: ReadonlyArray<BillingInput>,
    source: {
      readonly name: string;
      readonly sha256: string | null;
      readonly coverageStart: string;
      readonly coverageEnd: string;
    } | null,
  ) =>
    transaction("add billing", () => {
      const now = new Date().toISOString();
      let importId: number | null = null;
      if (source) {
        if (
          source.sha256 &&
          db
            .prepare("SELECT 1 FROM billing_imports WHERE file_sha256 = ?")
            .get(source.sha256)
        )
          return { importId: null, inserted: 0, duplicate: true };
        importId = Number(
          db
            .prepare(
              "INSERT INTO billing_imports (source, file_sha256, coverage_start, coverage_end, imported_at, row_count) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              source.name,
              source.sha256,
              source.coverageStart,
              source.coverageEnd,
              now,
              records.length,
            ).lastInsertRowid,
        );
      }
      const insert = db.prepare(
        `INSERT INTO billing_records (import_id, source, kind, provider, account, amount_minor, currency,
           occurred_on, period_start, period_end, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of records)
        insert.run(
          importId,
          source ? `import:${source.name}` : "manual",
          r.kind,
          r.provider,
          r.account,
          r.amountMinor,
          r.currency,
          r.occurredOn,
          r.periodStart,
          r.periodEnd,
          r.description,
          now,
        );
      return { importId, inserted: records.length, duplicate: false };
    });
  const billing = (filter: Filter) =>
    run("list billing", () => {
      const clauses: string[] = [];
      const params: SQLInputValue[] = [];
      // A record belongs to a range when its occurrence or service period overlaps it.
      if (filter.from)
        (clauses.push("coalesce(period_end, occurred_on) >= ?"),
          params.push(filter.from));
      if (filter.to)
        (clauses.push("coalesce(period_start, occurred_on) <= ?"),
          params.push(filter.to));
      if (filter.provider)
        (clauses.push("provider = ?"), params.push(filter.provider));
      if (filter.account)
        (clauses.push("(account = ? OR account IS NULL)"),
          params.push(filter.account));
      return {
        records: db
          .prepare(
            `SELECT id, import_id AS importId, source, kind, provider, account, amount_minor AS amountMinor,
               currency, occurred_on AS occurredOn, period_start AS periodStart, period_end AS periodEnd,
               description FROM billing_records ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
             ORDER BY occurred_on DESC, id DESC`,
          )
          .all(...params) as Row[],
        imports: db
          .prepare(
            "SELECT id, source, coverage_start AS coverageStart, coverage_end AS coverageEnd, imported_at AS importedAt, row_count AS rows FROM billing_imports ORDER BY imported_at DESC",
          )
          .all() as Row[],
      };
    });
  const deleteBilling = (id: number) =>
    run(
      "delete billing",
      () =>
        db
          .prepare(
            "DELETE FROM billing_records WHERE id = ? AND import_id IS NULL",
          )
          .run(id).changes > 0,
    );
  const deleteImport = (id: number) =>
    run(
      "delete import",
      () =>
        db.prepare("DELETE FROM billing_imports WHERE id = ?").run(id).changes >
        0,
    );

  const addGatewayRequests = (counts: ReadonlyArray<GatewayRequestCount>) =>
    transaction("record gateway requests", () => {
      const upsert = db.prepare(
        `INSERT INTO gateway_requests (day, provider, principal_kind, device_id, transport, status_class, client_closed, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET count = count + excluded.count`,
      );
      for (const c of counts)
        upsert.run(
          c.day,
          c.provider,
          c.principalKind,
          c.deviceId,
          c.transport,
          c.statusClass,
          c.clientClosed ? 1 : 0,
          c.count,
        );
    });
  const gatewayRequests = (filter: Filter) =>
    run("gateway requests", () => {
      const clauses: string[] = [];
      const params: SQLInputValue[] = [];
      if (filter.from) (clauses.push("day >= ?"), params.push(filter.from));
      if (filter.to) (clauses.push("day <= ?"), params.push(filter.to));
      if (filter.provider)
        (clauses.push("provider = ?"), params.push(filter.provider));
      if (filter.device === "shared-key")
        clauses.push("principal_kind = 'shared-key'");
      else if (filter.device === "unattributed")
        clauses.push("principal_kind NOT IN ('device', 'shared-key')");
      else if (filter.device)
        (clauses.push("device_id = ?"), params.push(filter.device));
      return db
        .prepare(
          `SELECT provider, transport, status_class AS statusClass, client_closed AS clientClosed, sum(count) AS count
           FROM gateway_requests ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
           GROUP BY provider, transport, status_class, client_closed`,
        )
        .all(...params) as Row[];
    });

  return {
    ingest,
    addGatewayRequests,
    gatewayRequests,
    segments,
    markDeleted,
    orphanedSegments,
    closeSupersededWriters,
    groups,
    rows,
    coverage,
    options,
    devices,
    addDevice,
    revokeDevice,
    addBilling,
    billing,
    deleteBilling,
    deleteImport,
  };
};

export type LedgerService = ReturnType<typeof makeLedger>;
export class Ledger extends Context.Service<Ledger, LedgerService>()(
  "cli-proxy/Ledger",
) {}

export const ledgerPath = (dataDir: string) =>
  join(dataDir, "accounting.sqlite");

export const openLedger = (path: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => openDatabase(path),
      catch: (cause) =>
        new LedgerError({
          message: "Could not open the accounting database",
          cause,
        }),
    }),
    (db) => Effect.sync(() => db.close()),
  ).pipe(Effect.map(makeLedger));

export const LedgerLive = Layer.effect(
  Ledger,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const dir = config.demo ? ":memory:" : config.dataDir;
    if (dir === ":memory:") return yield* openLedger(":memory:");
    yield* Effect.try({
      try: () => mkdirSync(dir, { recursive: true, mode: 0o700 }),
      catch: (cause) =>
        new LedgerError({
          message: "Could not create the data directory",
          cause,
        }),
    });
    const path = ledgerPath(dir);
    const ledger = yield* openLedger(path);
    // Owner-only, like the other private state files.
    yield* Effect.sync(() => {
      for (const file of [path, `${path}-wal`, `${path}-shm`])
        try {
          chmodSync(file, 0o600);
        } catch {}
    });
    return ledger;
  }),
);
