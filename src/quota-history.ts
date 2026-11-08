import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Account } from "./domain.ts";
import type { Group } from "./usage-report.ts";

export interface QuotaSample {
  account: string;
  provider: string;
  window: string;
  at: string;
  remaining: number;
  resetsAt: string | null;
  source: "provider" | "native-cli";
}
export interface NativeUsage {
  id: string;
  at?: string;
  group: Group;
  project?: string;
  task?: string;
  taskTitle?: string;
  estimatedUsd?: number | null;
  priceBasis?: string;
  rateSnapshotAt?: string | null;
}
export interface HistoryImport {
  version: 1;
  sourceCacheAt?: string;
  sourceCacheVersion?: number;
  month: string;
  usage: NativeUsage[];
  quota: QuotaSample[];
}
function open(data: string) {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const path = join(data, "history.sqlite");
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  db.exec(`CREATE TABLE IF NOT EXISTS quota_samples (account TEXT NOT NULL, provider TEXT NOT NULL, window TEXT NOT NULL, at TEXT NOT NULL, remaining REAL NOT NULL, resets_at TEXT, source TEXT NOT NULL, PRIMARY KEY(account,provider,window,at));
  CREATE TABLE IF NOT EXISTS native_usage (id TEXT PRIMARY KEY, day TEXT NOT NULL, provider TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS quota_time ON quota_samples(at);`);
  return db;
}
export function insertHistory(data: string, history: HistoryImport) {
  const db = open(data);
  let usage = 0,
    quota = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    const put = db.prepare(
      "INSERT OR IGNORE INTO quota_samples VALUES (?,?,?,?,?,?,?)",
    );
    for (const s of history.quota) {
      if (
        !Number.isFinite(s.remaining) ||
        s.remaining < 0 ||
        s.remaining > 100 ||
        !Number.isFinite(Date.parse(s.at))
      )
        continue;
      quota += Number(
        put.run(
          s.account,
          s.provider,
          s.window,
          s.at,
          s.remaining,
          s.resetsAt,
          s.source,
        ).changes,
      );
    }
    const add = db.prepare(
      "INSERT INTO native_usage VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE native_usage.payload<>excluded.payload",
    );
    for (const u of history.usage)
      usage += Number(
        add.run(u.id, u.group.day, u.group.provider, JSON.stringify(u)).changes,
      );
    db.exec("COMMIT");
    return { usage, quota };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
}
export function recordQuota(data: string, accounts: ReadonlyArray<Account>) {
  const quota: QuotaSample[] = [];
  for (const a of accounts) {
    if (a.disabled || a.quotaError || !a.quota) continue;
    for (const w of a.quota.windows)
      if (/seven_day|weekly|7.day/i.test(w.id + " " + w.label))
        quota.push({
          account: createHash("sha256").update(a.id).digest("hex").slice(0, 12),
          provider: a.provider,
          window: w.id,
          at: a.quota.fetchedAt,
          remaining: w.remaining,
          resetsAt: w.resetsAt,
          source: "provider",
        });
  }
  return insertHistory(data, { version: 1, month: "live", usage: [], quota });
}
export function readHistory(
  data: string,
  filter: { from?: string; to?: string; provider?: string } = {},
) {
  if (!existsSync(join(data, "history.sqlite")))
    return {
      quota: [] as QuotaSample[],
      groups: [] as Group[],
      activity: [] as NativeUsage[],
    };
  const db = open(data);
  try {
    const from = filter.from || "0000",
      to = (filter.to || "9999") + "T23:59:59.999Z";
    const quota = db
      .prepare(
        "SELECT * FROM quota_samples WHERE at >= ? AND at <= ? ORDER BY at",
      )
      .all(from, to)
      .filter(
        (r) =>
          !filter.provider ||
          filter.provider === "all" ||
          r.provider === filter.provider,
      )
      .map((r) => ({
        account: String(r.account),
        provider: String(r.provider),
        window: String(r.window),
        at: String(r.at),
        remaining: Number(r.remaining),
        resetsAt: r.resets_at === null ? null : String(r.resets_at),
        source:
          r.source === "provider"
            ? ("provider" as const)
            : ("native-cli" as const),
      }));
    const stored = db
      .prepare("SELECT payload FROM native_usage WHERE day >= ? AND day <= ?")
      .all(filter.from || "0000", filter.to || "9999")
      .map((r) => JSON.parse(String(r.payload)) as NativeUsage);
    const activity = stored.filter(
      (u) =>
        !filter.provider ||
        filter.provider === "all" ||
        u.group.provider === filter.provider,
    );
    const groups = activity.map((u) => u.group);
    return { quota, groups, activity };
  } finally {
    db.close();
  }
}
