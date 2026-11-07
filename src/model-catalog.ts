import { records } from "./domain.ts";
import type { JsonObject } from "./domain.ts";
import { modelProvider } from "./quota.ts";

const ownerProvider = (owner: string) =>
  (
    ({
      openai: "codex",
      codex: "codex",
      anthropic: "claude",
      claude: "claude",
    }) as Record<string, string>
  )[owner.toLowerCase()];

// Keep provider metadata authoritative: aliases and Anthropic-cloaked IDs can
// name a different family from the actual provider serving the model.
export function filterModelCatalog(
  payload: JsonObject,
  provider: string,
  owners: ReadonlyMap<string, unknown> = new Map(),
): JsonObject {
  const key = Array.isArray(payload?.models) ? "models" : "data";
  if (!Array.isArray(payload?.[key])) throw new Error("Invalid model catalog");
  const models = records(payload[key]).filter((model) => {
    const id = model.slug ?? model.id;
    const owner = [model?.owned_by, owners.get(String(id))].find(
      (value) => typeof value === "string" && value.trim(),
    );
    if (typeof owner === "string")
      return ownerProvider(owner.trim()) === provider;
    // Synthetic Claude names do not identify their underlying provider.
    return (
      !(typeof id === "string" && /^claude-fable-5-dd-/i.test(id)) &&
      modelProvider(id) === provider
    );
  });
  const result: Record<string, unknown> = { ...payload, [key]: models };
  if ("first_id" in payload) result.first_id = models[0]?.id ?? "";
  if ("last_id" in payload) result.last_id = models.at(-1)?.id ?? "";
  return result;
}
