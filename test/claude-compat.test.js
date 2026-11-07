import test from "node:test";
import assert from "node:assert/strict";
import { restoreProxyReset } from "../src/claude-compat.ts";
test("Claude API-key refusals expose proxy reset metadata to T3", () => {
  const frame = {
    type: "assistant",
    error: "rate_limit",
    message: {
      content: [
        {
          type: "text",
          text: "API Error: Request rejected (429) · Nearest Claude account reset: 2026-10-25T14:20:00.000Z.",
        },
      ],
    },
  };
  assert.deepEqual(restoreProxyReset(frame).api_error_params.rate_limit_info, {
    status: "rejected",
    rateLimitType: "unknown",
    resetsAt: 1792938000,
    isUsingOverage: false,
  });
  assert.equal(
    restoreProxyReset({ ...frame, error: undefined }).api_error_params,
    undefined,
  );
  const native = {
    ...frame,
    api_error_params: { rate_limit_info: { resetsAt: 42 } },
  };
  assert.equal(restoreProxyReset(native), native);
  assert.equal(
    restoreProxyReset({
      type: "assistant",
      error: "rate_limit",
      message: { content: [{ type: "text", text: "No known reset" }] },
    }).api_error_params,
    undefined,
  );
});
