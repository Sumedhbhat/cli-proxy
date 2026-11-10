import type { DashboardState } from "../src/domain.ts";
import { present } from "./test-helpers.ts";
import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import vm from "node:vm";

// Execute the shipped browser bundle so assertions cover the actual dashboard.
export async function dashboard(t: TestContext, state: DashboardState) {
  type Handler = (event?: unknown) => unknown;
  type Element = {
    innerHTML: string;
    handlers: Record<string, Handler>;
    addEventListener(type: string, handler: Handler): void;
  };
  const elements = new Map<string, Element>();
  const element = (selector: string) => {
    if (!elements.has(selector))
      elements.set(selector, {
        innerHTML: "",
        handlers: {},
        addEventListener(type: string, handler: Handler) {
          this.handlers[type] = handler;
        },
      });
    return present(elements.get(selector));
  };
  const location = { href: "http://localhost/", hash: "#quota" },
    handlers: Record<string, Handler> = {};
  const source = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  await vm.runInNewContext(`(async () => { ${source}\n })()`, {
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      documentElement: { dataset: {} },
      body: { classList: { remove() {} } },
    },
    window: {
      addEventListener(type: string, handler: Handler) {
        handlers[type] = handler;
      },
    },
    location,
    localStorage: { getItem: () => null },
    URL,
    Date,
    TextEncoder,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance,
    fetch: async () => ({ ok: true, json: async () => state }),
    setInterval() {},
  });
  t.after(() => handlers.pagehide?.({ persisted: false }));
  return { main: element("#main"), location, handlers };
}
