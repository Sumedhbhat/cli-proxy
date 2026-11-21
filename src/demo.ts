import type { Account } from "./domain.ts";
export function demoAccounts(): Account[] {
  const now = Date.now();
  const days = (n: number) => new Date(now + n * 86400000).toISOString();
  const make = (
    id: string,
    provider: string,
    email: string,
    remaining: number,
    hours: number,
    reset: number,
    extra: number | null = null,
    availableResets: number | null = null,
    expiryDays: number | null = null,
  ): Account => ({
    id,
    name: `${provider}-${email}.json`,
    email,
    provider,
    disabled: false,
    runtimeOnly: false,
    status: "active",
    priority: 0,
    supportsQuota: false,
    accountId: null,
    quotaError: null,
    plan: provider === "claude" ? "Max" : "Pro",
    success: 0,
    failed: 0,
    quota: {
      plan: null,
      availableResets,
      nextResetExpiresAt: expiryDays == null ? null : days(expiryDays),
      fetchedAt: new Date().toISOString(),
      windows: [
        {
          id: provider === "claude" ? "seven_day" : "weekly",
          label: provider === "claude" ? "7-day limit" : "Weekly limit",
          remaining,
          resetsAt: days(reset),
        },
        {
          id: "five_hour",
          label: "5-hour limit",
          remaining: hours,
          resetsAt: days(0.12),
        },
        ...(extra == null
          ? []
          : [
              {
                id: "seven_day_opus",
                label: "7-day Opus",
                remaining: extra,
                resetsAt: days(reset),
              },
            ]),
      ],
    },
  });
  return [
    make("c1", "claude", "studio@home.dev", 58, 100, 0.8, 79, 1, 12),
    make("c2", "claude", "build@home.dev", 100, 100, 3.7, 100, 0),
    make("c3", "claude", "research@home.dev", 100, 100, 4.4, 100),
    make("c4", "claude", "work@home.dev", 51, 99, 0.55, 75),
    make("c5", "claude", "personal@home.dev", 100, 100, 5.8, 100),
    make("o1", "codex", "studio@home.dev", 17, 82, 1.4, null, 2, 24),
    make("o2", "codex", "build@home.dev", 0, 0, 2.2, null, 0),
    make("o3", "codex", "personal@home.dev", 0, 0, 4),
    make("x1", "xai", "studio@home.dev", 62, 100, 4.7),
    make("k1", "kimi", "studio@home.dev", 100, 100, 4.8),
  ];
}
