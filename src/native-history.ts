// Read metadata from native CLI transcripts used by T3. Never write to these
// sources or retain prompts, messages, tool inputs, credentials or raw records.
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { record } from "./domain.ts";
import { classifyTokens, contextBucket } from "./accounting.ts";
import type { RawTokens } from "./accounting.ts";
import type {
  HistoryImport,
  NativeUsage,
  QuotaSample,
} from "./quota-history.ts";

async function* files(path: string): AsyncGenerator<string> {
  const entries = await fs
    .readdir(path, { withFileTypes: true })
    .catch(() => []);
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(path, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export async function collectNativeHistory(
  month: string,
  codex: string,
  claude: string,
): Promise<HistoryImport> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Month must be YYYY-MM");
  const usage = new Map<string, NativeUsage>(),
    quota = new Map<string, QuotaSample>();
  for (const [provider, root] of [
    ["codex", codex],
    ["claude", claude],
  ] as const) {
    for await (const file of files(root)) {
      let session = "",
        model = "unknown";
      for await (const line of createInterface({
        input: createReadStream(file),
        crlfDelay: Infinity,
      })) {
        let event: Record<string, unknown>;
        try {
          event = record(JSON.parse(line));
        } catch {
          continue;
        }
        const p = record(event.payload);
        if (event.type === "session_meta") session = String(p.id || "");
        if (event.type === "turn_context" && typeof p.model === "string")
          model = p.model;
        const at = String(event.timestamp || "");
        if (!at.startsWith(month + "-")) continue;
        let id = "",
          raw: RawTokens | undefined;
        if (
          provider === "codex" &&
          event.type === "event_msg" &&
          p.type === "token_count"
        ) {
          const info = record(p.info),
            last = record(info.last_token_usage),
            total = record(info.total_token_usage);
          if (Object.keys(total).length && Object.keys(last).length) {
            id = hash(`codex:${session || file}:${JSON.stringify(total)}`);
            raw = {
              cache_read: 0,
              input: number(last.input_tokens),
              cached: number(last.cached_input_tokens),
              cache_creation: number(last.cache_write_input_tokens),
              output: number(last.output_tokens),
              reasoning: number(last.reasoning_output_tokens),
              total: number(last.total_tokens),
            };
          }
          const rates = record(p.rate_limits),
            weekly = record(rates.secondary);
          if (
            number(weekly.window_minutes) >= 10080 &&
            typeof weekly.used_percent === "number"
          ) {
            const sample: QuotaSample = {
              account: "native-codex-unidentified",
              provider,
              window: "weekly",
              at,
              remaining: 100 - weekly.used_percent,
              resetsAt:
                typeof weekly.resets_at === "number"
                  ? new Date(weekly.resets_at * 1000).toISOString()
                  : null,
              source: "native-cli",
            };
            quota.set(hash(JSON.stringify(sample)), sample);
          }
        }
        if (provider === "claude" && event.type === "assistant") {
          const message = record(event.message),
            u = record(message.usage);
          if (
            typeof message.id !== "string" ||
            !Object.keys(u).length ||
            String(message.model).startsWith("<")
          )
            continue;
          model = String(message.model || "unknown");
          id = hash("claude:" + message.id);
          raw = {
            cached: 0,
            total: 0,
            input: number(u.input_tokens),
            cache_read: number(u.cache_read_input_tokens),
            cache_creation: number(u.cache_creation_input_tokens),
            output: number(u.output_tokens),
            reasoning: number(record(u.output_tokens_details).thinking_tokens),
          };
        }
        if (!id || !raw) continue;
        const classified = classifyTokens(provider, raw, false);
        const prior = usage.get(id);
        // Streaming records can repeat an assistant id. Keep its largest final
        // reported usage instead of counting every chunk as a fresh execution.
        if (
          prior &&
          (prior.group.tokens.total || 0) >= (classified.tokens.total || 0)
        )
          continue;
        usage.set(id, {
          id,
          group: {
            day: at.slice(0, 10),
            provider,
            model,
            tier: "standard",
            context: contextBucket(provider, model, classified.tokens),
            usageStatus: "estimated",
            account: null,
            device: null,
            principal: "native-cli-history",
            classified: true,
            outcome: "unknown",
            executions: 1,
            tokens: classified.tokens,
          },
        });
      }
    }
  }
  return {
    version: 1,
    month,
    usage: [...usage.values()],
    quota: [...quota.values()],
  };
}
