import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InputError } from "./domain.ts";

const Environment = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  engineURL: Schema.String,
  managementKey: Schema.String,
  apiKey: Schema.String,
  demo: Schema.Boolean,
  dataDir: Schema.String,
  ledgerDeviceSecret: Schema.String,
});
export interface Configuration {
  readonly port: number;
  readonly engineURL: string;
  readonly demo: boolean;
  readonly dataDir: string;
  readonly managementKey: Redacted.Redacted<string>;
  readonly apiKey: Redacted.Redacted<string>;
  // Shared with the engine's ledger plugin to sign device attribution.
  readonly ledgerDeviceSecret: Redacted.Redacted<string> | null;
}
export class AppConfig extends Context.Service<AppConfig, Configuration>()(
  "cli-proxy/Config",
) {}
export const loadConfig = Effect.gen(function* () {
  const config = yield* Schema.decodeUnknownEffect(Environment)({
    port: Number(process.env.PORT || 8318),
    engineURL: process.env.ENGINE_URL || "http://127.0.0.1:8317",
    managementKey: process.env.ENGINE_MANAGEMENT_KEY || "",
    apiKey: process.env.PROXY_API_KEY || "",
    demo: process.argv.includes("--demo"),
    dataDir: resolve(
      process.env.DATA_DIR ||
        fileURLToPath(new URL("../.local/", import.meta.url)),
    ),
    ledgerDeviceSecret: process.env.LEDGER_DEVICE_SECRET || "",
  }).pipe(
    Effect.mapError(
      () =>
        new InputError({
          status: 400,
          message: "Invalid environment configuration",
        }),
    ),
  );
  const url = yield* Effect.try({
    try: () => new URL(config.engineURL),
    catch: () => new InputError({ status: 400, message: "Invalid ENGINE_URL" }),
  });
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return yield* new InputError({
      status: 400,
      message:
        "ENGINE_URL must be an HTTP(S) URL without credentials, query, or fragment",
    });
  }
  if (!config.demo && (!config.apiKey || !config.managementKey)) {
    return yield* new InputError({
      status: 400,
      message:
        "Run npm run setup first, or npm run demo to explore without credentials.",
    });
  }
  if (config.ledgerDeviceSecret && config.ledgerDeviceSecret.length < 32)
    return yield* new InputError({
      status: 400,
      message: "LEDGER_DEVICE_SECRET must be at least 32 characters",
    });
  return {
    ...config,
    managementKey: Redacted.make(config.managementKey),
    apiKey: Redacted.make(config.apiKey),
    ledgerDeviceSecret: config.ledgerDeviceSecret
      ? Redacted.make(config.ledgerDeviceSecret)
      : null,
  };
});
export const ConfigLive = Layer.effect(AppConfig, loadConfig);
