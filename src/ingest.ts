// Moves sanitized engine records from the outbox into the accounting database.
//
// Each segment's byte offset is committed in the same transaction as the rows
// read before it, so a crash or storage failure re-reads from the last commit
// and the execution-ID primary key absorbs any repeated line.
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { join } from "node:path";
import { AppConfig } from "./config.ts";
import { Ledger } from "./ledger.ts";
import type {
  CoverageEvent,
  ExecutionRow,
  GatewayRequestCount,
  IngestBatch,
} from "./ledger.ts";
import {
  ACCOUNTING_VERSION,
  classifyOutcome,
  classifyTokens,
  contextBucket,
  resolveTier,
} from "./accounting.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const optionalString = Schema.optional(Schema.String);
export const UsageEvent = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("usage"),
  recorded_at: Schema.String,
  execution_id: Schema.String.check(Schema.isMinLength(1)),
  trace_id: optionalString,
  selection_id: optionalString,
  provider: Schema.String,
  executor: optionalString,
  model: optionalString,
  alias: optionalString,
  response_model: optionalString,
  auth_id: optionalString,
  auth_type: optionalString,
  principal: Schema.String,
  requested_at: optionalString,
  latency_ms: Schema.Number,
  ttft_ms: Schema.Number,
  stream: Schema.Boolean,
  generate: Schema.Boolean,
  failed: Schema.Boolean,
  status_code: Schema.optional(Schema.Number),
  reasoning_effort: optionalString,
  service_tier: optionalString,
  effective_service_tier: optionalString,
  response_service_tier: optionalString,
  tokens: Schema.Struct({
    input: Count,
    output: Count,
    reasoning: Count,
    cached: Count,
    cache_read: Count,
    cache_creation: Count,
    total: Count,
  }),
});
export type UsageEvent = typeof UsageEvent.Type;
const Marker = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literals(["segment-start", "segment-end", "write-failures"]),
  at: Schema.String,
  writer: Schema.String,
  writer_started_at: Schema.String,
  plugin_version: optionalString,
  final: Schema.optional(Schema.Boolean),
  failed_writes: Schema.optional(Count),
  dropped: Schema.optional(Count),
  dropped_ids: Schema.optional(Schema.Array(Schema.String)),
  undecodable: Schema.optional(Count),
  pending: Schema.optional(Count),
  pending_ids: Schema.optional(Schema.Array(Schema.String)),
});
const decodeUsage = Schema.decodeUnknownOption(UsageEvent);
const decodeMarker = Schema.decodeUnknownOption(Marker);

const isoOrNull = (value: string | undefined) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

/** Converts one sanitized outbox event into a ledger row. */
export function toExecution(event: UsageEvent): ExecutionRow {
  const device = event.principal.startsWith("device:")
    ? event.principal.slice(7)
    : null;
  const requestedAt =
    isoOrNull(event.requested_at) ??
    isoOrNull(event.recorded_at) ??
    new Date(0).toISOString();
  const pricedModel = event.response_model || event.model || "unknown";
  const classified = classifyTokens(event.provider, event.tokens, event.failed);
  return {
    executionId: event.execution_id,
    traceId: event.trace_id || null,
    selectionId: event.selection_id || null,
    provider: event.provider,
    executor: event.executor || null,
    model: event.model || null,
    responseModel: event.response_model || null,
    pricedModel,
    accountId: event.auth_id || null,
    authType: event.auth_type || null,
    deviceId: device,
    principalKind: device ? "device" : event.principal,
    requestedAt,
    recordedAt: isoOrNull(event.recorded_at) ?? requestedAt,
    day: requestedAt.slice(0, 10),
    latencyMs: event.latency_ms,
    ttftMs: event.ttft_ms || null,
    stream: event.stream,
    outcome: classifyOutcome(event.failed, event.status_code ?? 0),
    statusCode: event.status_code ?? null,
    serviceTier: resolveTier(
      event.provider,
      event.response_service_tier ?? "",
      event.effective_service_tier ?? "",
      event.service_tier ?? "",
    ),
    reasoningEffort: event.reasoning_effort || null,
    usageStatus: classified.status,
    usageNote: classified.note,
    tokens: classified.tokens,
    contextBucket: contextBucket(
      event.provider,
      pricedModel,
      classified.tokens,
    ),
    rawTokens: JSON.stringify(event.tokens),
    accountingVersion: ACCOUNTING_VERSION,
  };
}

const ids = (values: ReadonlyArray<string> | undefined) =>
  values?.length ? JSON.stringify(values.slice(0, 200)) : null;

/**
 * Interprets the complete lines in `text`, which starts at byte `start` of a
 * segment. Bytes after the last newline belong to a line still being written.
 */
export function interpretChunk(
  segment: string,
  text: Buffer,
  start: number,
): IngestBatch & { readonly consumed: number } {
  const executions: Array<ExecutionRow & { offset: number }> = [];
  const coverage: CoverageEvent[] = [];
  let writer: IngestBatch["writer"] = null;
  let writerEndedAt: string | null = null;
  let lastSeenAt: string | null = null;
  let ended = false;
  let invalidLines = 0;
  let cursor = 0;
  for (;;) {
    const newline = text.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const offset = start + cursor;
    const line = text.subarray(cursor, newline).toString("utf8");
    cursor = newline + 1;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidLines++;
      continue;
    }
    const usage = decodeUsage(value);
    if (Option.isSome(usage)) {
      // Requests that only count tokens generate nothing to account for.
      if (!usage.value.generate) continue;
      executions.push({ ...toExecution(usage.value), offset });
      lastSeenAt = usage.value.recorded_at;
      continue;
    }
    const marker = decodeMarker(value);
    if (Option.isNone(marker)) {
      invalidLines++;
      continue;
    }
    const m = marker.value;
    lastSeenAt = m.at;
    if (m.type === "segment-start")
      writer = {
        id: m.writer,
        startedAt: m.writer_started_at,
        pluginVersion: m.plugin_version ?? null,
      };
    else if (m.type === "segment-end") {
      ended = true;
      if (m.final) writerEndedAt = m.at;
      if (m.pending)
        coverage.push({
          kind: "lost-at-shutdown",
          at: m.at,
          writer: m.writer,
          count: m.pending,
          detail: ids(m.pending_ids),
        });
    } else {
      if (m.failed_writes)
        coverage.push({
          kind: "storage-retry",
          at: m.at,
          writer: m.writer,
          count: m.failed_writes,
          detail:
            "The outbox refused writes; affected executions were kept in memory and written later.",
        });
      if (m.dropped)
        coverage.push({
          kind: "dropped",
          at: m.at,
          writer: m.writer,
          count: m.dropped,
          detail: ids(m.dropped_ids),
        });
      if (m.undecodable)
        coverage.push({
          kind: "undecodable",
          at: m.at,
          writer: m.writer,
          count: m.undecodable,
          detail: null,
        });
    }
  }
  return {
    segment,
    offset: start + cursor,
    consumed: cursor,
    ended,
    writer,
    writerEndedAt,
    lastSeenAt,
    executions,
    coverage,
    invalidLines,
  };
}

export interface IngestStatus {
  readonly outboxDir: string;
  readonly lastRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  readonly backlogBytes: number;
  readonly ingested: number;
  readonly duplicates: number;
}

const CHUNK_BYTES = 4 << 20;
const RETENTION_MS = 24 * 3600 * 1000;

export const makeIngest = Effect.fn("Ingest.make")(function* (
  outboxDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const ledger = yield* Ledger;
  const status = yield* Ref.make<IngestStatus>({
    outboxDir,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    backlogBytes: 0,
    ingested: 0,
    duplicates: 0,
  });

  const readFrom = (path: string, position: number, size: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path, { flag: "r" });
        const bytes = yield* file.readAlloc(Math.min(size, CHUNK_BYTES), {
          position: BigInt(position),
        });
        return Option.match(bytes, {
          onNone: () => Buffer.alloc(0),
          onSome: (b) => Buffer.from(b),
        });
      }),
    );

  const ingestSegment = Effect.fn("Ingest.segment")(function* (
    name: string,
    known: { offset: number; ended: boolean } | undefined,
    orphaned: boolean,
  ) {
    const path = join(outboxDir, name);
    const info = yield* fs.stat(path);
    const size = Number(info.size);
    let offset = known?.offset ?? 0;
    let totals = { inserted: 0, duplicates: 0 };
    while (offset < size) {
      const bytes = yield* readFrom(path, offset, size - offset);
      const batch = interpretChunk(name, bytes, offset);
      if (batch.consumed === 0) {
        // No newline left: a writer that has stopped tore its final line.
        if (!orphaned) break;
        yield* ledger.ingest({
          ...batch,
          offset: size,
          ended: true,
          coverage: [
            {
              kind: "torn-record",
              at: new Date().toISOString(),
              writer: null,
              count: 1,
              detail: `${size - offset} unterminated bytes at the end of ${name}`,
            },
          ],
        });
        offset = size;
        break;
      }
      const result = yield* ledger.ingest(batch);
      totals = {
        inserted: totals.inserted + result.inserted,
        duplicates: totals.duplicates + result.duplicates,
      };
      offset = batch.offset;
    }
    if (orphaned && offset >= size && !known?.ended)
      yield* ledger.ingest({
        ...interpretChunk(name, Buffer.alloc(0), offset),
        ended: true,
      });
    return { ...totals, remaining: size - offset };
  });

  // Deletes segments that are finished, fully ingested, and past retention.
  const prune = Effect.fn("Ingest.prune")(function* (
    names: ReadonlyArray<string>,
  ) {
    const segments = yield* ledger.segments;
    for (const name of names) {
      const known = segments.get(name);
      if (!known?.ended || known.deleted) continue;
      const info = yield* fs.stat(join(outboxDir, name));
      const modified =
        Option.getOrUndefined(info.mtime)?.getTime() ?? Date.now();
      if (
        known.offset >= Number(info.size) &&
        Date.now() - modified > RETENTION_MS
      ) {
        yield* fs.remove(join(outboxDir, name));
        yield* ledger.markDeleted(name);
      }
    }
  });

  // Gateway request counts are buffered and written with each ingestion pass,
  // keeping database writes off the request path. A crash loses at most one
  // interval of these diagnostic counts, never execution records.
  const pending = yield* Ref.make(new Map<string, GatewayRequestCount>());
  const countRequest = (request: Omit<GatewayRequestCount, "count" | "day">) =>
    Ref.update(pending, (map) => {
      const day = new Date().toISOString().slice(0, 10);
      const key = [
        day,
        request.provider,
        request.principalKind,
        request.deviceId,
        request.transport,
        request.statusClass,
        request.clientClosed,
      ].join("\u0000");
      const next = new Map(map);
      next.set(key, { ...request, day, count: (map.get(key)?.count ?? 0) + 1 });
      return next;
    });
  const flushRequests = Effect.gen(function* () {
    const counts = yield* Ref.getAndSet(pending, new Map());
    if (!counts.size) return;
    yield* ledger.addGatewayRequests([...counts.values()]).pipe(
      // Put them back for the next pass rather than dropping them.
      Effect.tapError(() =>
        Ref.update(pending, (map) => {
          const next = new Map(map);
          for (const [key, value] of counts)
            next.set(key, {
              ...value,
              count: value.count + (map.get(key)?.count ?? 0),
            });
          return next;
        }),
      ),
    );
  });

  const runOnce = Effect.gen(function* () {
    yield* flushRequests;
    const at = new Date().toISOString();
    if (!(yield* fs.exists(outboxDir))) {
      yield* Ref.update(status, (s) => ({
        ...s,
        lastRunAt: at,
        lastSuccessAt: at,
        lastError: null,
        backlogBytes: 0,
      }));
      return;
    }
    const names = (yield* fs.readDirectory(outboxDir))
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    let backlog = 0;
    let inserted = 0;
    let duplicates = 0;
    // Segments are processed sequentially: the database has a single writer.
    for (const name of names) {
      const segments = yield* ledger.segments;
      const orphaned = yield* ledger.orphanedSegments;
      const known = segments.get(name);
      if (known?.deleted) continue;
      const result = yield* ingestSegment(name, known, orphaned.has(name));
      backlog += result.remaining;
      inserted += result.inserted;
      duplicates += result.duplicates;
    }
    yield* ledger.closeSupersededWriters;
    yield* prune(names);
    yield* Ref.update(status, (s) => ({
      ...s,
      lastRunAt: at,
      lastSuccessAt: at,
      lastError: null,
      backlogBytes: backlog,
      ingested: s.ingested + inserted,
      duplicates: s.duplicates + duplicates,
    }));
  }).pipe(
    // Storage failures leave offsets uncommitted; the next run retries them.
    Effect.catch((error) =>
      Ref.update(status, (s) => ({
        ...s,
        lastRunAt: new Date().toISOString(),
        lastError:
          "message" in error ? String(error.message) : "Ingestion failed",
      })),
    ),
  );

  return { runOnce, flushRequests, countRequest, status: Ref.get(status) };
});

export type IngestService = Effect.Success<ReturnType<typeof makeIngest>>;
export class Ingest extends Context.Service<Ingest, IngestService>()(
  "cli-proxy/Ingest",
) {}
export const outboxPath = (dataDir: string) => join(dataDir, "usage-outbox");
export const IngestLive = Layer.effect(
  Ingest,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return yield* makeIngest(outboxPath(config.dataDir));
  }),
);
/** The background loop; owned by the server scope and interrupted on shutdown. */
export const ingestLoop = Effect.gen(function* () {
  const ingest = yield* Ingest;
  yield* ingest.runOnce.pipe(
    Effect.repeat(Schedule.spaced("2 seconds")),
    // Shutdown interrupts the loop between commits; keep the buffered counts.
    Effect.ensuring(ingest.flushRequests.pipe(Effect.ignore)),
  );
});
