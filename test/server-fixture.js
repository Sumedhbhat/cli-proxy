import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startGateway(
  t,
  handler,
  settings = { scheduler: false, intervalSeconds: 3600 },
) {
  const engine = http.createServer(handler);
  const engineSockets = new Set();
  engine.on("connection", (socket) => {
    engineSockets.add(socket);
    socket.once("close", () => engineSockets.delete(socket));
  });
  engine.listen(0, "127.0.0.1");
  await once(engine, "listening");
  const dataDir = await mkdtemp(join(tmpdir(), "cli-proxy-effect-"));
  await writeFile(join(dataDir, "settings.json"), JSON.stringify(settings));
  const child = spawn(process.execPath, ["src/server.ts"], {
    env: {
      ...process.env,
      PORT: "0",
      DATA_DIR: dataDir,
      ENGINE_URL: `http://127.0.0.1:${engine.address().port}`,
      ENGINE_MANAGEMENT_KEY: "management-test",
      PROXY_API_KEY: "proxy-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Gateway did not shut down: ${output}`));
        }, 5000);
        timer.unref();
      }),
    ]);
    for (const socket of engineSockets) socket.destroy();
    await new Promise((resolve) => engine.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = await Promise.race([
    new Promise((resolve) =>
      child.stdout.on("data", (chunk) => {
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk));
        if (match) resolve(match[0]);
      }),
    ),
    exited.then(([code]) => {
      throw new Error(`Gateway exited (${code}): ${output}`);
    }),
  ]);
  return { base, dataDir, child, exited, engine };
}
