import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendDiagnostic,
  recentDiagnostics,
  reasonCode,
  requestRoute,
  releaseIdentity,
} from "../src/diagnostics.ts";
import { startGateway } from "./server-fixture.ts";

test("diagnostics rotate, remain private, discard unknown fields and preserve chronological metadata", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "proxy-diagnostics-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const untrusted = {
    kind: "request",
    status: "ok",
    prompt: "secret-prompt",
    authorization: "secret-key",
  };
  await appendDiagnostic(dir, "app", untrusted);
  const file = join(dir, "diagnostics/app.jsonl");
  assert.doesNotMatch(
    await fs.readFile(file, "utf8"),
    /secret-prompt|secret-key/,
  );
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.appendFile(file, "x".repeat(2 * 1024 * 1024));
  await appendDiagnostic(dir, "app", { kind: "request", httpStatus: 200 });
  await fs.access(file + ".1");
  assert.ok((await recentDiagnostics(dir)).some((e) => e.httpStatus === 200));
  assert.equal(
    reasonCode(new Error("Cannot find package '@effect/platform-node'")),
    "missing_dependency",
  );
  assert.equal(requestRoute("/private-token/path"), "other");
});
test("health and ordinary service responses carry the running release and a request id", async (t) => {
  const { base } = await startGateway(t, (_req, res) => res.end('{"data":[]}'));
  const health = await fetch(base + "/healthz");
  const data = await health.json();
  assert.equal(health.headers.get("x-cli-proxy-release"), data.release);
  assert.ok(data.startedAt);
  assert.ok(typeof data.uptimeSeconds === "number");
  const denied = await fetch(base + "/v1/models");
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("x-cli-proxy-release"), data.release);
  assert.ok(denied.headers.get("x-cli-proxy-request-id"));
  assert.equal(releaseIdentity("/does-not-exist").release, "development");
});
