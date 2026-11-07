// Adds the usage ledger to an existing installation without touching other
// settings: a device-attribution secret in .env and the plugin block in the
// engine configuration. Running it again changes nothing.
import { Effect, FileSystem } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { InputError } from "./domain.ts";

export const LEDGER_PLUGIN_ID = "cli-proxy-ledger";

const envValue = (env: string, name: string) =>
  new RegExp(`^${name}=(.*)$`, "m").exec(env)?.[1]?.trim() ?? "";

export const pluginBlock = (
  dataDir: string,
  secret: string,
  keyDigest: string,
) =>
  [
    "# Usage ledger: records sanitized usage metadata for the console.",
    "plugins:",
    "  enabled: true",
    `  dir: ${JSON.stringify(join(dataDir, "plugins"))}`,
    "  configs:",
    `    ${LEDGER_PLUGIN_ID}:`,
    "      enabled: true",
    "      priority: 100",
    `      outbox-dir: ${JSON.stringify(join(dataDir, "usage-outbox"))}`,
    `      device-secret: ${JSON.stringify(secret)}`,
    `      engine-key-sha256: ${JSON.stringify(keyDigest)}`,
    "",
  ].join("\n");

/** Pure configuration update; returns null when nothing needs to change. */
export function updateEngineConfig(
  yaml: string,
  dataDir: string,
  secret: string,
  apiKey: string,
): string | null {
  const digest = createHash("sha256").update(apiKey).digest("hex");
  // While loaded, the plugin is the engine's only authenticator. It must accept
  // the gateway's key, so refuse to configure it against a different key.
  const keys = /^api-keys:\s*\n((?:\s+-.*\n?)+)/m.exec(yaml)?.[1] ?? "";
  const listed = [
    ...keys.matchAll(/^\s+-\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))\s*$/gm),
  ].map((m) => (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : (m[2] ?? m[3])));
  if (!listed.includes(apiKey))
    throw new Error(
      "engine.yaml api-keys does not include PROXY_API_KEY. The ledger plugin would reject the gateway; fix the keys first.",
    );
  if (listed.length > 1)
    throw new Error(
      "engine.yaml lists several client keys. The ledger plugin accepts only the gateway key; configure it by hand (docs/usage-ledger.md).",
    );
  if (!/^plugins:/m.test(yaml))
    return `${yaml.replace(/\n*$/, "\n")}${pluginBlock(dataDir, secret, digest)}`;
  if (!new RegExp(`^ {4}${LEDGER_PLUGIN_ID}:`, "m").test(yaml))
    throw new Error(
      `engine.yaml already has a plugins section. Add plugins.configs.${LEDGER_PLUGIN_ID} by hand; see docs/usage-ledger.md.`,
    );
  // Keep the plugin's view of the gateway key and secret in step with .env.
  const next = yaml
    .replace(/^( {6}engine-key-sha256:).*$/m, `$1 ${JSON.stringify(digest)}`)
    .replace(/^( {6}device-secret:).*$/m, `$1 ${JSON.stringify(secret)}`);
  return next === yaml ? null : next;
}

export const ensureLedgerConfig = Effect.fn("Ledger.configure")(function* (
  envPath: string,
  engineConfigPath: string,
  dataDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const env = yield* fs.readFileString(envPath);
  const existing = envValue(env, "LEDGER_DEVICE_SECRET");
  const secret = existing || randomBytes(32).toString("hex");
  const apiKey = envValue(env, "PROXY_API_KEY");
  if (!apiKey)
    return yield* new InputError({
      status: 400,
      message: "PROXY_API_KEY missing from .env",
    });
  const yaml = yield* fs.readFileString(engineConfigPath);
  // Validate before writing anything: a configuration that cannot be updated
  // safely leaves both files untouched and the gateway running without a ledger.
  const next = yield* Effect.try({
    try: () => updateEngineConfig(yaml, dataDir, secret, apiKey),
    catch: (cause) =>
      new InputError({
        status: 409,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  if (!existing) {
    yield* fs.writeFileString(
      envPath,
      `${env.replace(/\n*$/, "\n")}LEDGER_DEVICE_SECRET=${secret}\n`,
      { mode: 0o600 },
    );
    yield* fs.chmod(envPath, 0o600);
  }
  if (next !== null) {
    yield* fs.writeFileString(engineConfigPath, next, { mode: 0o600 });
    yield* fs.chmod(engineConfigPath, 0o600);
  }
  yield* fs.makeDirectory(join(dataDir, "plugins"), {
    recursive: true,
    mode: 0o700,
  });
  return { changed: next !== null };
});

/** Setup and installation continue without the ledger when it cannot be added safely. */
export const configureLedgerOrSkip = (
  envPath: string,
  engineConfigPath: string,
  dataDir: string,
) =>
  ensureLedgerConfig(envPath, engineConfigPath, dataDir).pipe(
    Effect.catchTag("InputError", (error) =>
      error.status === 409
        ? Effect.sync(() => {
            console.warn(`Usage ledger not configured: ${error.message}`);
            return { changed: false };
          })
        : Effect.fail(error),
    ),
  );
