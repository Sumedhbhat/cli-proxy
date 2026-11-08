// Built-ins only: status and log export must work even if application imports fail.
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";

export interface ReleaseIdentity {
  release: string;
  commit: string;
  dirty: boolean;
  build: string;
  engineVersion: string;
  nodeVersion: string;
}
export function releaseIdentity(
  path: string,
  fallback = "development",
): ReleaseIdentity {
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    return {
      release: String(m.id),
      commit: String(m.sourceCommit || "unknown"),
      dirty: m.sourceDirty === true,
      build: String(m.buildDigest || "unknown"),
      engineVersion: String(m.engineVersion || "unknown"),
      nodeVersion: process.version,
    };
  } catch {
    return {
      release: fallback,
      commit: "unknown",
      dirty: true,
      build: "unknown",
      engineVersion: "unknown",
      nodeVersion: process.version,
    };
  }
}
export type DiagnosticChannel = "app" | "health" | "deploy" | "setup";
export interface DiagnosticEvent {
  kind: string;
  release?: string;
  commit?: string;
  status?: string;
  reason?: string;
  step?: string;
  requestId?: string;
  route?: string;
  httpStatus?: number;
  durationMs?: number;
}
const queues = new Map<string, Promise<void>>();
const channels: DiagnosticChannel[] = ["app", "health", "deploy", "setup"];
function fields(event: DiagnosticEvent) {
  // Explicit allowlist: never spread a request, exception, header map or environment.
  return Object.fromEntries(
    Object.entries({
      kind: event.kind,
      release: event.release,
      commit: event.commit,
      status: event.status,
      reason: event.reason,
      step: event.step,
      requestId: event.requestId,
      route: event.route,
      httpStatus: event.httpStatus,
      durationMs: event.durationMs,
    })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 160) : v]),
  );
}
export function appendDiagnostic(
  data: string,
  channel: DiagnosticChannel,
  event: DiagnosticEvent,
): Promise<void> {
  const file = join(data, "diagnostics", channel + ".jsonl");
  const next = (queues.get(file) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(join(data, "diagnostics"), {
        recursive: true,
        mode: 0o700,
      });
      const size = await fs.stat(file).then(
        (s) => s.size,
        () => 0,
      );
      if (size >= 2 * 1024 * 1024) {
        await fs.rm(file + ".3", { force: true });
        for (let i = 2; i >= 1; i--)
          await fs.rename(file + "." + i, file + "." + (i + 1)).catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
        await fs.rename(file, file + ".1");
      }
      await fs.appendFile(
        file,
        JSON.stringify({ at: new Date().toISOString(), ...fields(event) }) +
          "\n",
        { mode: 0o600 },
      );
      await fs.chmod(file, 0o600);
    });
  queues.set(file, next);
  return next;
}
export function reasonCode(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/ERR_MODULE_NOT_FOUND|Cannot find package/.test(text))
    return "missing_dependency";
  if (/EADDRINUSE/.test(text)) return "port_in_use";
  if (/EACCES|permission denied/i.test(text)) return "permission_denied";
  if (/401|403/.test(text)) return "authentication_failed";
  if (/Unexpected release/.test(text)) return "version_mismatch";
  if (/timeout|timed out/i.test(text)) return "timeout";
  return "service_unavailable";
}
export async function recentDiagnostics(data: string, limit = 40) {
  const all: Array<Record<string, unknown>> = [];
  for (const channel of channels) {
    // Include the prior segment so a just-rotated log still has context.
    for (const suffix of [".1", ""]) {
      const text = await fs
        .readFile(
          join(data, "diagnostics", channel + ".jsonl" + suffix),
          "utf8",
        )
        .catch(() => "");
      for (const line of text.trim().split("\n").slice(-limit))
        try {
          const value = JSON.parse(line);
          all.push({ at: value.at, channel, ...fields(value) });
        } catch {}
    }
  }
  return all
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-limit);
}
export async function diagnosticReport(root: string) {
  const data = join(root, ".local");
  const current = await fs.realpath(join(root, "current")).catch(() => null);
  const previous = await fs.realpath(join(root, "previous")).catch(() => null);
  const expected = current
    ? releaseIdentity(join(current, "release.json"))
    : null;
  const exec = promisify(execFile);
  const names = [
    "cli-proxy-engine.service",
    "cli-proxy-console.service",
    "cli-proxy-health.timer",
    "cli-proxy-history.timer",
  ];
  const services = await Promise.all(
    names.map(async (name) => {
      const output = await exec(
        "systemctl",
        [
          "--user",
          "show",
          name,
          "-p",
          "ActiveState",
          "-p",
          "SubState",
          "-p",
          "NRestarts",
          "-p",
          "ExecMainStatus",
        ],
        { timeout: 5000 },
      ).then(
        (v) => v.stdout,
        () => "",
      );
      const values = Object.fromEntries(
        output
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      return {
        name,
        state: values.ActiveState || "unknown",
        subState: values.SubState || "unknown",
        restarts: Number(values.NRestarts || 0),
        exitCode: Number(values.ExecMainStatus || 0),
      };
    }),
  );
  const { parseEnv } = await import("node:util");
  const env = parseEnv(
    await fs.readFile(join(root, ".env"), "utf8").catch(() => ""),
  );
  let running: Record<string, unknown> | null = null;
  let gatewayReason: string | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${env.PORT || 8318}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error("service_unavailable");
    const v = await res.json();
    running = {
      release: v.release,
      commit: v.commit,
      dirty: v.dirty,
      build: v.build,
      engineVersion: v.engineVersion,
      uptimeSeconds: v.uptimeSeconds,
      nodeVersion: v.nodeVersion,
    };
    if (expected && v.release !== expected.release)
      gatewayReason = "version_mismatch";
  } catch (e) {
    gatewayReason = reasonCode(e);
  }
  const events = await recentDiagnostics(data);
  let heartbeat: Record<string, unknown> | null = null;
  try {
    const lines = (
      await fs.readFile(join(data, "diagnostics/health.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    const v = JSON.parse(lines.at(-1) || "{}");
    heartbeat = { at: v.at, ...fields(v) };
  } catch {}
  let history: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(
      await fs.readFile(join(data, "history-status.json"), "utf8"),
    );
    history = {
      at: v.at,
      sourceCacheAt: v.sourceCacheAt,
      observations: v.observations,
      quotaObservations: v.quotaObservations,
    };
  } catch {}
  let startupReason: string | null = null;
  if (gatewayReason) {
    const log = await exec(
      "journalctl",
      [
        "--user",
        "-u",
        "cli-proxy-console.service",
        "-n",
        "40",
        "--no-pager",
        "-o",
        "cat",
      ],
      { timeout: 5000 },
    ).then(
      (v) => v.stdout,
      () => "",
    );
    if (/ERR_MODULE_NOT_FOUND|EADDRINUSE|EACCES/.test(log))
      startupReason = reasonCode(log);
  }
  let incident: null | {
    at: string;
    reason: string;
    recoveredAt: string | null;
  } = null;
  try {
    const i = JSON.parse(
      await fs.readFile(join(root, "incident.json"), "utf8"),
    );
    incident = {
      at: i.at,
      reason: i.reason,
      recoveredAt: i.recoveredAt || null,
    };
  } catch {}
  return {
    formatVersion: 1,
    collectedAt: new Date().toISOString(),
    host: hostname(),
    expected,
    running,
    previous: previous ? releaseIdentity(join(previous, "release.json")) : null,
    healthy: !gatewayReason && services.every((s) => s.state === "active"),
    gatewayReason,
    startupReason,
    services,
    heartbeat,
    history,
    heartbeatStale:
      !heartbeat || Date.now() - Date.parse(String(heartbeat.at)) > 180000,
    incident,
    events,
  };
}
export function requestRoute(path: string) {
  return /^\/(?:codex\/|claude\/)?v1\/(?:responses|messages|messages\/count_tokens|models|chat\/completions|completions|embeddings)$/.test(
    path,
  )
    ? path
    : path.startsWith("/api/")
      ? "/api/*"
      : "other";
}
