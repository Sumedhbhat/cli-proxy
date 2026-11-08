// A local stand-in for the Anthropic Messages and OpenAI Responses APIs.
// It returns provider-shaped usage so the real engine parses it; no tokens
// are generated and no paid inference is called.
import http from "node:http";

export interface MockCall {
  readonly path: string;
  readonly model: string;
  readonly stream: boolean;
}
export interface MockOptions {
  // Fail the next N requests whose body contains the marker, then succeed.
  readonly failFirst?: Record<
    string,
    { readonly count: number; readonly status: number }
  >;
}
// A request whose body contains this marker streams one event and then stalls,
// so tests can interrupt it before the provider reports terminal usage.
export const STALL = "MOCK_STALL";

const claudeUsage = {
  input_tokens: 100,
  cache_read_input_tokens: 400,
  cache_creation_input_tokens: 50,
  cache_creation: {
    ephemeral_5m_input_tokens: 50,
    ephemeral_1h_input_tokens: 0,
  },
  service_tier: "standard",
};
const codexUsage = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 600 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 200 },
  total_tokens: 1300,
};

const sse = (res: http.ServerResponse, event: string, data: unknown) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export function startMockProvider(options: MockOptions = {}) {
  const calls: MockCall[] = [];
  const failures = new Map(
    Object.entries(options.failFirst ?? {}).map(([marker, rule]) => [
      marker,
      { ...rule },
    ]),
  );
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    const model = String(payload.model ?? "");
    const stream =
      payload.stream === true || req.url?.includes("/responses") === true;
    calls.push({ path: req.url ?? "", model, stream });
    const failure = [...failures].find(([marker]) =>
      body.includes(marker),
    )?.[1];
    if (failure && failure.count > 0) {
      failure.count--;
      res.writeHead(failure.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "mock limit" },
        }),
      );
      return;
    }
    if (req.url?.includes("/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 42 }));
      return;
    }
    const stall = body.includes(STALL);
    if (req.url?.includes("/messages")) {
      const message = {
        id: `msg_${calls.length}`,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...message,
            usage: { ...claudeUsage, output_tokens: 20 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", {
        type: "message_start",
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { ...claudeUsage, output_tokens: 1 },
        },
      });
      sse(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      });
      if (stall) return; // Never sends message_delta: usage stays partial.
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 20 },
      });
      sse(res, "message_stop", { type: "message_stop" });
      res.end();
      return;
    }
    if (req.url?.includes("/responses")) {
      const response = {
        id: `resp_${calls.length}`,
        object: "response",
        model,
        status: "in_progress",
        output: [],
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "response.created", { type: "response.created", response });
      if (stall) return; // Never sends response.completed: usage stays unknown.
      const item = {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      };
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item,
      });
      sse(res, "response.completed", {
        type: "response.completed",
        response: {
          ...response,
          status: "completed",
          output: [item],
          usage: codexUsage,
          service_tier: "default",
        },
      });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise<{
    url: string;
    calls: MockCall[];
    close: () => Promise<void>;
  }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockProvider({
    failFirst: { MOCK_FAIL_ONCE: { count: 1, status: 429 } },
  });
  console.log(mock.url);
}
