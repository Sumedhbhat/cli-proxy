import { records } from "../src/domain.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { filterModelCatalog } from "../src/model-catalog.ts";

test("missing ownership preserves genuine model IDs but never infers a synthetic cloak", () => {
  const payload = {
    data: [
      { id: "gpt-6.1-sol", owned_by: "" },
      { id: "claude-opus-5-5", owned_by: " " },
      { id: "claude-fable-5-dd-rehto", owned_by: "" },
      { id: "alias", owned_by: "" },
      { id: "gpt-foreign", owned_by: "google" },
    ],
  };
  const owners = new Map([["alias", "openai"]]);
  assert.deepEqual(
    records(filterModelCatalog(payload, "codex", owners).data).map(
      (model) => model.id,
    ),
    ["gpt-6.1-sol", "alias"],
  );
  assert.deepEqual(
    records(filterModelCatalog(payload, "claude", owners).data).map(
      (model) => model.id,
    ),
    ["claude-opus-5-5"],
  );
});

test("provider ownership takes precedence over aliases and cloaked model IDs", () => {
  const payload = {
    data: [
      { id: "g5", owned_by: "openai" },
      { id: "claude-fable-5-dd-rehto", owned_by: "openai" },
      { id: "writing", owned_by: "anthropic" },
      { id: "gpt-foreign", owned_by: "google" },
    ],
    first_id: "g5",
    last_id: "gpt-foreign",
    has_more: false,
  };
  const claude = filterModelCatalog(payload, "claude");
  assert.deepEqual(claude, {
    data: [payload.data[2]],
    first_id: "writing",
    last_id: "writing",
    has_more: false,
  });
  assert.deepEqual(
    filterModelCatalog(payload, "codex").data,
    payload.data.slice(0, 2),
  );
  assert.equal(payload.data.length, 4);
});

test("Codex capabilities and response envelope survive filtering by canonical ownership", () => {
  const payload = {
    models: [
      {
        slug: "g5",
        context_window: 400000,
        supported_reasoning_levels: [{ effort: "high" }],
      },
      { slug: "claude-opus-5-5", context_window: 200000 },
    ],
    extra: "preserved",
  };
  const owners = new Map([
    ["g5", "openai"],
    ["claude-opus-5-5", "anthropic"],
  ]);
  assert.deepEqual(filterModelCatalog(payload, "codex", owners), {
    models: [payload.models[0]],
    extra: "preserved",
  });
  assert.throws(
    () => filterModelCatalog({ error: "bad" }, "codex"),
    /Invalid model catalog/,
  );
});
