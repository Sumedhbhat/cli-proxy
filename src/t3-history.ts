// This adapter only reads T3's cache and opens its database read-only. It never
// invokes T3, refreshes its cache, updates settings or writes to its directories.
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { record } from "./domain.ts";
import { contextBucket } from "./accounting.ts";
import type { HistoryImport, NativeUsage } from "./quota-history.ts";

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
interface Attribution {
  project: string;
  task: string;
  title: string;
}
function metadata(path: string) {
  const sessions = new Map<string, Attribution>();
  const paths: Array<{ path: string; attribution: Attribution }> = [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only=ON");
    const projects = new Map(
      db
        .prepare(
          "SELECT project_id,title,workspace_root FROM projection_projects",
        )
        .all()
        .map((p) => [
          String(p.project_id),
          { title: String(p.title), path: String(p.workspace_root) },
        ]),
    );
    for (const [id, p] of projects)
      paths.push({
        path: p.path,
        attribution: { project: p.title, task: "", title: "" },
      });
    const threads = new Map<string, Attribution>();
    for (const table of [
      "projection_threads",
      "orchestration_v2_projection_threads",
    ]) {
      try {
        for (const t of db.prepare(`SELECT * FROM ${table}`).all()) {
          const a = {
            project:
              projects.get(String(t.project_id))?.title || "Unassigned project",
            task: String(t.thread_id),
            title: String(t.title),
          };
          threads.set(String(t.thread_id), a);
          const payload = t.payload_json
            ? record(JSON.parse(String(t.payload_json)))
            : {};
          const worktree = t.worktree_path || payload.worktreePath;
          if (typeof worktree === "string")
            paths.push({ path: worktree, attribution: a });
        }
      } catch {}
    }
    for (const t of db
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads",
      )
      .all()) {
      const p = record(JSON.parse(String(t.payload_json))),
        ref = record(p.nativeThreadRef);
      const a = threads.get(String(p.appThreadId));
      if (a && typeof ref.nativeId === "string") sessions.set(ref.nativeId, a);
    }
  } catch {
  } finally {
    db?.close();
  }
  paths.sort((a, b) => b.path.length - a.path.length);
  return { sessions, paths };
}
function price(
  row: unknown[],
  models: string[],
  rates: Record<string, unknown>,
  provider: string,
) {
  if (typeof row[9] === "number" && Number.isFinite(row[9]) && row[9] >= 0)
    return { value: row[9], basis: "t3-reported" };
  const model = (
    typeof row[11] === "number" ? models[row[11]] : models[Number(row[1])]
  )
    .trim()
    .toLowerCase()
    .split("[")[0];
  const bare = model.slice(model.lastIndexOf("/") + 1);
  if (["opus", "sonnet", "haiku", "fable", "synthetic"].includes(bare))
    return { value: null, basis: "unpriced" };
  const entry = record(
    rates[model] ||
      rates[(provider === "claude" ? "anthropic/" : "openai/") + model],
  );
  const finite = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  const baseInput = finite(entry.input_cost_per_token),
    baseOutput = finite(entry.output_cost_per_token);
  if (baseInput === null || baseOutput === null)
    return { value: null, basis: "unpriced" };
  const baseCache = finite(entry.cache_read_input_token_cost) ?? baseInput;
  const baseWrite = finite(entry.cache_creation_input_token_cost) ?? baseInput;
  const multiple = finite(record(entry.provider_specific_entry).fast);
  const suffix =
    row[10] === 2 ? "_ultrafast" : row[10] === 1 ? "_priority" : "";
  const fastScale =
    row[10] === 1 && multiple !== null && multiple > 0 ? multiple : null;
  const tierInput = finite(entry["input_cost_per_token" + suffix]);
  const tierOutput = finite(entry["output_cost_per_token" + suffix]);
  const hasTier = suffix !== "" && tierInput !== null && tierOutput !== null;
  const input =
    fastScale !== null
      ? baseInput * fastScale
      : hasTier
        ? tierInput
        : baseInput;
  const output =
    fastScale !== null
      ? baseOutput * fastScale
      : hasTier
        ? tierOutput
        : baseOutput;
  const cache =
    fastScale !== null
      ? baseCache * fastScale
      : hasTier
        ? (finite(entry["cache_read_input_token_cost" + suffix]) ??
          (baseInput > 0 ? (baseCache / baseInput) * input : input))
        : baseCache;
  const write =
    fastScale !== null
      ? baseWrite * fastScale
      : hasTier
        ? (finite(entry["cache_creation_input_token_cost" + suffix]) ??
          (baseInput > 0 ? (baseWrite / baseInput) * input : input))
        : baseWrite;
  return {
    value:
      num(row[3]) * input +
      num(row[4]) * cache +
      num(row[5]) * write +
      num(row[6]) * output,
    basis: "t3-rate-snapshot",
  };
}
export async function collectT3History(
  userdata: string,
  month: string,
): Promise<HistoryImport> {
  if (month !== "all" && !/^\d{4}-\d{2}$/.test(month))
    throw new Error("Month must be YYYY-MM or all");
  const names = (await fs.readdir(userdata))
    .filter((n) => /^usage-scan-cache-v\d+\.json$/.test(n))
    .sort(
      (a, b) => Number(b.match(/v(\d+)/)?.[1]) - Number(a.match(/v(\d+)/)?.[1]),
    );
  const file = names[0];
  if (!file) throw new Error("No T3 usage scan cache found");
  const cache = record(
    JSON.parse(await fs.readFile(join(userdata, file), "utf8")),
  );
  if (![9, 10, 11].includes(Number(cache.version)))
    throw new Error(
      `Unsupported T3 usage cache version ${cache.version}; refusing to guess its layout`,
    );
  const models = Array.isArray(cache.models) ? cache.models.map(String) : [],
    sessions = Array.isArray(cache.sessions) ? cache.sessions.map(String) : [];
  const modelRates = record(
    JSON.parse(
      await fs
        .readFile(join(userdata, "usage-model-rates.json"), "utf8")
        .catch(() => "{}"),
    ),
  );
  const rates = record(modelRates.document);
  const attribution = metadata(join(userdata, "statev2.sqlite"));
  const usage = new Map<string, NativeUsage>();
  for (const [filePath, raw] of Object.entries(record(cache.files))) {
    const f = record(raw);
    if (f.p !== "codex" && f.p !== "claude") continue;
    const entries = [
      ...(Array.isArray(f.r) ? f.r : []),
      ...(Array.isArray(f.t) ? f.t : []),
    ];
    for (const rawRow of entries) {
      if (
        !Array.isArray(rawRow) ||
        rawRow.length < 11 ||
        typeof rawRow[0] !== "number"
      )
        continue;
      const at = new Date(rawRow[0]).toISOString();
      if (month !== "all" && !at.startsWith(month + "-")) continue;
      const session = sessions[Number(rawRow[2])] || "unknown",
        model = models[Number(rawRow[1])] || "unknown";
      if (model === "<synthetic>") continue;
      const key =
        typeof rawRow[8] === "string"
          ? rawRow[8]
          : JSON.stringify([session, at, model, ...rawRow.slice(3, 8)]);
      const id = createHash("sha256").update(`t3:${f.p}:${key}`).digest("hex");
      if (usage.has(id)) continue;
      const match =
        attribution.sessions.get(session) ||
        [...attribution.sessions].find(([id]) => filePath.includes(id))?.[1] ||
        attribution.paths.find(
          (p) =>
            filePath.includes(p.path) ||
            filePath.includes(p.path.replaceAll("/", "-")),
        )?.attribution;
      const task = match?.task || `native:${session}`;
      const tokens = {
        inputUncached: num(rawRow[3]),
        cacheRead: num(rawRow[4]),
        cacheWrite: num(rawRow[5]),
        output: num(rawRow[6]),
        reasoning: num(rawRow[7]),
        total:
          num(rawRow[3]) + num(rawRow[4]) + num(rawRow[5]) + num(rawRow[6]),
      };
      const cost = price(rawRow, models, rates, f.p);
      usage.set(id, {
        id,
        at,
        project: match?.project || "Unassigned project",
        task,
        taskTitle: match?.title || "Native conversation",
        estimatedUsd: cost.value,
        priceBasis: cost.basis,
        rateSnapshotAt:
          typeof modelRates.fetchedAtMs === "number"
            ? new Date(modelRates.fetchedAtMs).toISOString()
            : null,
        group: {
          day: at.slice(0, 10),
          provider: f.p,
          model,
          tier: rawRow[10] === 0 ? "standard" : "fast",
          context: contextBucket(f.p, model, tokens),
          usageStatus: "estimated",
          account: null,
          device: null,
          principal: "t3-cache",
          classified: true,
          outcome: "unknown",
          executions: 1,
          tokens,
        },
      });
    }
  }
  return {
    version: 1,
    month,
    sourceCacheAt: (await fs.stat(join(userdata, file))).mtime.toISOString(),
    sourceCacheVersion: Number(cache.version),
    usage: [...usage.values()],
    quota: [],
  };
}
