import { Data, Schema } from "effect";

export const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
export type JsonObject = typeof JsonObject.Type;
export const record = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
export const records = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.map(record) : [];

export const QuotaWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  remaining: Schema.Number,
  resetsAt: Schema.NullOr(Schema.String),
});
export type QuotaWindow = typeof QuotaWindow.Type;
export const Quota = Schema.Struct({
  windows: Schema.Array(QuotaWindow),
  fetchedAt: Schema.String,
  availableResets: Schema.NullOr(Schema.Number),
  nextResetExpiresAt: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(Schema.String),
});
export type Quota = typeof Quota.Type;
export const Account = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  provider: Schema.String,
  disabled: Schema.Boolean,
  runtimeOnly: Schema.Boolean,
  status: Schema.String,
  priority: Schema.Number,
  supportsQuota: Schema.Boolean,
  accountId: Schema.NullOr(Schema.String),
  plan: Schema.String,
  success: Schema.Number,
  failed: Schema.Number,
  quota: Schema.NullOr(Quota),
  quotaError: Schema.NullOr(Schema.String),
});
export type Account = typeof Account.Type;
export type QuotaAccount = Pick<Account, "id" | "provider" | "supportsQuota"> &
  Partial<Pick<Account, "accountId">>;
export type RankedAccount = Pick<Account, "id" | "name" | "provider"> &
  Partial<Pick<Account, "disabled" | "runtimeOnly" | "quota">>;
export const Rank = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  priority: Schema.Number,
  reason: Schema.String,
});
export type Rank = typeof Rank.Type;
export const Settings = Schema.Struct({
  scheduler: Schema.Boolean,
  intervalSeconds: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 86400 }),
  ),
});
export type Settings = typeof Settings.Type;
export const PriorityBackup = Schema.Array(
  Schema.Struct({ name: Schema.String, priority: Schema.Number }),
);
export type PriorityBackup = typeof PriorityBackup.Type;
export const QuotaCache = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    quota: Schema.NullOr(Quota),
    quotaError: Schema.NullOr(Schema.String),
  }),
);
export type QuotaCache = typeof QuotaCache.Type;
export const Event = Schema.Struct({
  at: Schema.String,
  type: Schema.String,
  message: Schema.String,
  detail: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.String),
});
export type Event = typeof Event.Type;
export type DashboardState = typeof DashboardState.Type;

export class EngineError extends Data.TaggedError("EngineError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
export class InputError extends Data.TaggedError("InputError")<{
  readonly message: string;
  readonly status: number;
}> {}
export class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const DashboardState = Schema.Struct({
  demo: Schema.Boolean,
  connected: Schema.Boolean,
  accounts: Schema.Array(Account),
  settings: Settings,
  routing: Schema.Struct({
    strategy: Schema.optional(Schema.String),
    affinity: Schema.Boolean,
  }),
  refreshing: Schema.Boolean,
  lastRefresh: Schema.NullOr(Schema.String),
  refreshError: Schema.NullOr(Schema.String),
  schedulerError: Schema.NullOr(Schema.String),
  ranks: Schema.Array(Rank),
  events: Schema.Array(Event),
});
