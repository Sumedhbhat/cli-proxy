import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { randomBytes, createHash } from "node:crypto";
import { platform, arch } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../src/command.ts";
import { InputError } from "../src/domain.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = join(root, ".local");
const version = "8.0.23"; // Published 2026-10-09; satisfies the 14-day dependency policy.
const platforms: Record<string, string> = { linux: "linux", darwin: "darwin" };
const architectures: Record<string, string> = {
  x64: "amd64",
  arm64: "aarch64",
};
const download = (url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Download returned HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    catch: (cause) =>
      new InputError({
        status: 502,
        message: `Download failed: ${cause instanceof Error ? cause.message : "network error"}`,
      }),
  }).pipe(Effect.timeout(120000));

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (!platforms[platform()] || !architectures[arch()])
    return yield* new InputError({
      status: 400,
      message:
        "Automatic setup supports Linux/macOS x64/arm64. Set ENGINE_URL for an existing engine.",
    });
  yield* fs.makeDirectory(join(local, "auth"), {
    recursive: true,
    mode: 0o700,
  });
  const installed = yield* fs
    .readFileString(join(local, "engine-version"))
    .pipe(
      Effect.map((value) => value.trim() === version),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
    );
  if (!installed) {
    console.log(
      `Downloading CLIProxyAPI v${version} and verifying its SHA-256 checksum…`,
    );
    const release = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}`;
    const asset = `CLIProxyAPI_${version}_${platforms[platform()]}_${architectures[arch()]}.tar.gz`;
    const [archive, sums] = yield* Effect.all(
      [download(`${release}/${asset}`), download(`${release}/checksums.txt`)],
      { concurrency: 2 },
    );
    const expected = sums
      .toString()
      .split("\n")
      .find((line) => line.trim().endsWith(asset))
      ?.trim()
      .split(/\s+/)[0];
    if (
      !expected ||
      createHash("sha256").update(archive).digest("hex") !== expected
    )
      return yield* new InputError({
        status: 502,
        message: "Engine checksum verification failed",
      });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "cli-proxy-install-",
        });
        const archivePath = join(dir, "engine.tar.gz");
        yield* fs.writeFile(archivePath, archive);
        yield* command("tar", ["-xzf", archivePath, "-C", dir]);
        const binary = (yield* fs.readDirectory(dir)).find((name) =>
          /^(cli-proxy-api|CLIProxyAPI|cliproxyapi)$/.test(name),
        );
        if (!binary)
          return yield* new InputError({
            status: 502,
            message: "Expected engine binary missing from release archive",
          });
        yield* fs.writeFile(
          join(local, "cli-proxy-api"),
          yield* fs.readFile(join(dir, binary)),
          { mode: 0o700 },
        );
        yield* fs.chmod(join(local, "cli-proxy-api"), 0o700);
        yield* fs.writeFileString(join(local, "engine-version"), version);
      }),
    );
  }
  if (!(yield* fs.exists(join(root, ".env")))) {
    const management = randomBytes(32).toString("hex"),
      apiKey = randomBytes(32).toString("hex");
    const env = `PORT=8318\nENGINE_URL=http://127.0.0.1:8317\nENGINE_MANAGEMENT_KEY=${management}\nPROXY_API_KEY=${apiKey}\n`;
    const config = `host: "127.0.0.1"\nport: 8317\nauth-dir: ${JSON.stringify(join(local, "auth"))}\nremote-management:\n  allow-remote: false\n  secret-key: ${JSON.stringify(management)}\n  disable-control-panel: true\napi-keys:\n  - ${JSON.stringify(apiKey)}\nrouting:\n  strategy: fill-first\n  session-affinity: true\n  session-affinity-ttl: 1h\n  session-affinity-rebind-on: quota\nws-auth: true\nrequest-retry: 2\nlogging-to-file: false\nusage-statistics-enabled: false\n`;

    yield* fs.writeFileString(join(local, "engine.yaml"), config, {
      mode: 0o600,
    });
    yield* fs.writeFileString(
      join(local, "settings.json"),
      JSON.stringify({ scheduler: true, intervalSeconds: 60 }),
      { mode: 0o600 },
    );
    yield* fs.writeFileString(join(root, ".env"), env, {
      mode: 0o600,
      flag: "wx",
    });
  }
  console.log(
    "Setup complete. Secrets are in .env (owner-readable only). Existing configuration was preserved.",
  );
  console.log(
    "Start the engine: npm run engine\nStart the console in another terminal: npm start\nOpen http://127.0.0.1:8318. Dashboard access is controlled by your local machine and Tailscale.",
  );
});
NodeRuntime.runMain(setup.pipe(Effect.provide(NodeServices.layer)));
