// Per-device gateway credentials. A device is identified only by the key it
// authenticates with; the gateway then signs that identity for the engine.
// Keys are shown once and stored as SHA-256 digests.
import { Context, Effect, Layer, Redacted, Ref } from "effect";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AppConfig } from "./config.ts";
import { InputError } from "./domain.ts";
import { equal } from "./http.ts";
import { Ledger } from "./ledger.ts";

export type Identity =
  | { readonly kind: "shared" }
  | { readonly kind: "device"; readonly id: string };

export const DEVICE_HEADER = "x-cli-proxy-device";
const devicePattern = /^[a-z0-9][a-z0-9-]{0,39}$/;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Matches the engine plugin's DeviceSignature. */
export const deviceSignature = (secret: string, id: string) =>
  createHmac("sha256", secret)
    .update(`cli-proxy-device:v1:${id}`)
    .digest("hex");

export const presentedKey = (req: IncomingMessage) => {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer "))
    return authorization.slice(7).trim();
  const key = req.headers["x-api-key"];
  return typeof key === "string" ? key.trim() : "";
};

export const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "device";

export const makeDevices = Effect.gen(function* () {
  const config = yield* AppConfig;
  const ledger = yield* Ledger;
  const shared = Redacted.value(config.apiKey);
  const secret = config.ledgerDeviceSecret
    ? Redacted.value(config.ledgerDeviceSecret)
    : null;
  const load = ledger.devices.pipe(
    Effect.map(
      (rows) =>
        new Map(
          rows
            .filter((row) => row.revoked_at === null)
            .map((row) => [String(row.key_sha256), String(row.id)]),
        ),
    ),
  );
  const active = yield* Ref.make(yield* load);
  const reload = Effect.flatMap(load, (map) => Ref.set(active, map));

  const identify = (req: IncomingMessage) =>
    Effect.gen(function* () {
      const key = presentedKey(req);
      if (!key) return null;
      if (equal(key, shared)) return { kind: "shared" } as Identity;
      // A digest lookup reveals nothing useful: keys carry 256 random bits.
      const id = (yield* Ref.get(active)).get(digest(key));
      return id ? ({ kind: "device", id } as Identity) : null;
    });

  return {
    attributionEnabled: secret !== null,
    identify,
    // The header the engine plugin verifies; null when attribution is off.
    attribution: (identity: Identity) =>
      secret && identity.kind === "device"
        ? `${identity.id}.${deviceSignature(secret, identity.id)}`
        : null,
    list: ledger.devices.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          id: String(row.id),
          label: String(row.label),
          createdAt: String(row.created_at),
          revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
        })),
      ),
    ),
    create: (label: string) =>
      Effect.gen(function* () {
        const name = label.trim().slice(0, 60);
        if (!name)
          return yield* new InputError({
            status: 400,
            message: "Device name required",
          });
        const id = `${slug(name)}-${randomBytes(3).toString("hex")}`;
        if (!devicePattern.test(id))
          return yield* new InputError({
            status: 400,
            message: "Invalid device name",
          });
        const key = `cpk_${randomBytes(32).toString("base64url")}`;
        yield* ledger.addDevice(id, name, digest(key));
        yield* reload;
        return { id, label: name, key };
      }),
    revoke: (id: string) =>
      Effect.gen(function* () {
        const revoked = yield* ledger.revokeDevice(id);
        yield* reload;
        return revoked;
      }),
  };
});

export type DevicesService = Effect.Success<typeof makeDevices>;
export class Devices extends Context.Service<Devices, DevicesService>()(
  "cli-proxy/Devices",
) {}
export const DevicesLive = Layer.effect(Devices, makeDevices);
