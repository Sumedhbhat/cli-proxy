// Dashboard API for usage, devices, and billing records.
import { Effect, Ref, Schema } from "effect";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppConfig } from "./config.ts";
import { Devices } from "./devices.ts";
import { InputError, record, records } from "./domain.ts";
import { Engine } from "./engine.ts";
import { decodeBody, json, send } from "./http.ts";
import { Ingest } from "./ingest.ts";
import { Ledger } from "./ledger.ts";
import type { Filter } from "./ledger.ts";
import { estimateGroup, methodology } from "./accounting.ts";
import type { UsageStatus } from "./accounting.ts";
import {
  parseBillingCsv,
  summarizeSpending,
  validateBilling,
} from "./billing.ts";
import { buildReport, toGroup } from "./usage-report.ts";

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
const DeviceInput = Schema.Struct({
  label: Schema.String.check(Schema.isMaxLength(60)),
});
const IdInput = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(80)),
});
const NumericId = Schema.Struct({ id: Schema.Int });
const optionalText = Schema.optional(
  Schema.String.check(Schema.isMaxLength(200)),
);
const BillingInput = Schema.Struct({
  date: Schema.String,
  kind: Schema.String,
  provider: Schema.String,
  amount: Schema.String,
  currency: Schema.String,
  account: optionalText,
  period_start: optionalText,
  period_end: optionalText,
  description: optionalText,
});
const ImportInput = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[\w .@()+-]{1,120}$/)),
  coverageStart: Day,
  coverageEnd: Day,
  csv: Schema.String,
});

export const parseFilter = (url: URL): Effect.Effect<Filter, InputError> =>
  Effect.gen(function* () {
    const get = (name: string) => {
      const value = url.searchParams.get(name)?.trim();
      return value ? value.slice(0, 200) : undefined;
    };
    const from = get("from");
    const to = get("to");
    for (const value of [from, to])
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value))
        return yield* new InputError({
          status: 400,
          message: "Dates must be YYYY-MM-DD",
        });
    return {
      from,
      to,
      provider: get("provider"),
      account: get("account"),
      device: get("device"),
      model: get("model"),
    };
  });

const CSV_COLUMNS = [
  "execution_id",
  "trace_id",
  "selection_id",
  "requested_at",
  "day",
  "provider",
  "account_id",
  "device_id",
  "principal_kind",
  "model",
  "response_model",
  "priced_model",
  "service_tier",
  "context_bucket",
  "outcome",
  "status_code",
  "stream",
  "usage_status",
  "usage_note",
  "input_uncached",
  "cache_read",
  "cache_write",
  "output",
  "reasoning",
  "total",
  "estimate_low_usd",
  "estimate_high_usd",
  "estimate_status",
  "price_id",
  "accounting_version",
  "pricing_catalog_version",
] as const;
const csvCell = (value: unknown) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // Neutralize spreadsheet formulas as well as quoting delimiters.
  const safe =
    /^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
const num = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

export const exportRow = (row: Record<string, unknown>) => {
  const tokens = {
    inputUncached: num(row.input_uncached),
    cacheRead: num(row.cache_read),
    cacheWrite: num(row.cache_write),
    output: num(row.output),
    reasoning: num(row.reasoning),
    total: num(row.total),
  };
  const value = estimateGroup({
    provider: String(row.provider),
    model: String(row.priced_model),
    tier: String(row.service_tier),
    context: row.context_bucket === "long" ? "long" : "standard",
    day: String(row.day),
    usageStatus: String(row.usage_status) as UsageStatus,
    tokens,
  });
  return {
    ...row,
    stream: Number(row.stream) === 1,
    estimate_low_usd:
      value.status === "no-price" || value.status === "no-usage"
        ? null
        : Number(value.low.toFixed(6)),
    estimate_high_usd:
      value.status === "no-price" || value.status === "no-usage"
        ? null
        : Number(value.high.toFixed(6)),
    estimate_status: value.status,
    price_id: value.priceId,
    pricing_catalog_version: methodology.pricingCatalogVersion,
  };
};

export const makeUsageApi = Effect.gen(function* () {
  const config = yield* AppConfig;
  const ledger = yield* Ledger;
  const ingest = yield* Ingest;
  const devices = yield* Devices;
  const engine = yield* Engine;
  const pluginCache = yield* Ref.make<{ at: number; value: unknown } | null>(
    null,
  );

  // The engine reports whether the ledger plugin is loaded; cached briefly.
  const pluginStatus = Effect.gen(function* () {
    if (config.demo)
      return { known: false, loaded: false, detail: "Demo mode" };
    const cached = yield* Ref.get(pluginCache);
    if (cached && Date.now() - cached.at < 30000) return cached.value;
    const value = yield* engine.request("plugins", { timeoutMs: 5000 }).pipe(
      Effect.map((payload) => {
        const plugin = records(record(payload).plugins).find(
          (p) => p.id === "cli-proxy-ledger",
        );
        return {
          known: true,
          loaded:
            plugin?.registered === true && plugin?.effective_enabled === true,
          detail: plugin
            ? `registered: ${plugin.registered === true}, enabled: ${plugin.effective_enabled === true}`
            : record(payload).plugins_enabled === true
              ? "Ledger plugin not installed"
              : "Engine plugins are disabled",
        };
      }),
      Effect.orElseSucceed(() => ({
        known: false,
        loaded: false,
        detail: "Engine plugin status unavailable",
      })),
    );
    yield* Ref.set(pluginCache, { at: Date.now(), value });
    return value;
  });

  const report = (filter: Filter) =>
    Effect.gen(function* () {
      const groups = (yield* ledger.groups(filter)).map(toGroup);
      const billing = yield* ledger.billing(filter);
      const coverage = yield* ledger.coverage;
      const options = yield* ledger.options;
      const deviceList = yield* devices.list;
      return {
        generatedAt: new Date().toISOString(),
        filter,
        ...buildReport(groups),
        coverage: {
          ...coverage,
          gatewayRequests: yield* ledger.gatewayRequests(filter),
          ingest: yield* ingest.status,
          plugin: yield* pluginStatus,
          attributionEnabled: devices.attributionEnabled,
        },
        spending: {
          totals: summarizeSpending(
            billing.records.map((r) => ({
              kind: String(r.kind),
              currency: String(r.currency),
              amountMinor: Number(r.amountMinor),
            })),
          ),
          records: billing.records,
          imports: billing.imports,
        },
        options: { ...options, deviceLabels: deviceList },
      };
    });

  const handle = (req: IncomingMessage, res: ServerResponse, url: URL) =>
    Effect.gen(function* () {
      const path = url.pathname;
      const method = req.method;
      if (path === "/api/usage" && method === "GET") {
        json(res, 200, yield* report(yield* parseFilter(url)));
        return true;
      }
      if (path === "/api/usage/export" && method === "GET") {
        const filter = yield* parseFilter(url);
        const csv = url.searchParams.get("format") === "csv";
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json",
          "Content-Disposition": `attachment; filename="cli-proxy-usage-${stamp}.${csv ? "csv" : "json"}"`,
          "Cache-Control": "no-store",
        });
        res.write(
          csv
            ? `${CSV_COLUMNS.join(",")}\r\n`
            : `{"exportedAt":${JSON.stringify(new Date().toISOString())},"filter":${JSON.stringify(filter)},"methodology":${JSON.stringify({ ...methodology, dayBoundary: "UTC", note: "Estimates are API-equivalent list-price values, not charges." })},"executions":[`,
        );
        let after: readonly [string, string] | null = null;
        let first = true;
        for (;;) {
          const page: ReadonlyArray<Record<string, unknown>> =
            yield* ledger.rows(filter, after, 2000);
          if (!page.length) break;
          const lines = page.map(exportRow).map((row) => {
            const line = csv
              ? CSV_COLUMNS.map((c) =>
                  csvCell((row as Record<string, unknown>)[c]),
                ).join(",") + "\r\n"
              : `${first ? "" : ","}${JSON.stringify(row)}`;
            first = false;
            return line;
          });
          // Respect backpressure so a large export does not buffer in memory.
          if (!res.write(lines.join("")))
            yield* Effect.callback<void>((resume) => {
              res.once("drain", () => resume(Effect.void));
            });
          const last: Record<string, unknown> = page[page.length - 1];
          after = [String(last.requested_at), String(last.execution_id)];
        }
        res.end(csv ? "" : "]}");
        return true;
      }
      if (path === "/api/devices" && method === "GET") {
        json(res, 200, {
          devices: yield* devices.list,
          attributionEnabled: devices.attributionEnabled,
        });
        return true;
      }
      if (path === "/api/devices" && method === "POST") {
        if (config.demo)
          return yield* new InputError({
            status: 409,
            message: "Device keys are available in live mode",
          });
        const { label } = yield* decodeBody(req, DeviceInput);
        json(res, 200, yield* devices.create(label));
        return true;
      }
      if (path === "/api/devices/revoke" && method === "POST") {
        const { id } = yield* decodeBody(req, IdInput);
        if (!(yield* devices.revoke(id)))
          return yield* new InputError({
            status: 404,
            message: "Unknown or revoked device",
          });
        json(res, 200, { ok: true });
        return true;
      }
      if (path === "/api/billing" && method === "POST") {
        const input = yield* decodeBody(req, BillingInput);
        const result = validateBilling(input);
        if (typeof result === "string")
          return yield* new InputError({ status: 400, message: result });
        yield* ledger.addBilling([result], null);
        json(res, 200, { ok: true });
        return true;
      }
      if (path === "/api/billing/import" && method === "POST") {
        const input = yield* decodeBody(req, ImportInput);
        if (input.coverageEnd < input.coverageStart)
          return yield* new InputError({
            status: 400,
            message: "Coverage ends before it starts",
          });
        const parsed = parseBillingCsv(input.csv);
        if (parsed.errors.length)
          return yield* new InputError({
            status: 400,
            message: parsed.errors.slice(0, 5).join("; "),
          });
        const result = yield* ledger.addBilling(parsed.records, {
          name: input.name,
          sha256: createHash("sha256").update(input.csv).digest("hex"),
          coverageStart: input.coverageStart,
          coverageEnd: input.coverageEnd,
        });
        if (result.duplicate)
          return yield* new InputError({
            status: 409,
            message: "This file was already imported",
          });
        json(res, 200, { ok: true, inserted: result.inserted });
        return true;
      }
      if (path === "/api/billing/delete" && method === "POST") {
        const { id } = yield* decodeBody(req, NumericId);
        if (!(yield* ledger.deleteBilling(id)))
          return yield* new InputError({
            status: 404,
            message: "Unknown manual record",
          });
        json(res, 200, { ok: true });
        return true;
      }
      if (path === "/api/billing/import/delete" && method === "POST") {
        const { id } = yield* decodeBody(req, NumericId);
        if (!(yield* ledger.deleteImport(id)))
          return yield* new InputError({
            status: 404,
            message: "Unknown import",
          });
        json(res, 200, { ok: true });
        return true;
      }
      return false;
    });
  return { handle };
});
