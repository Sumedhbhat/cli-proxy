import assert from "node:assert/strict";
import type { Server, AddressInfo } from "node:net";
import type { DashboardState } from "../src/domain.ts";

export function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "Expected a value");
  return value;
}
export function address(server: Server): AddressInfo {
  const value = server.address();
  assert.ok(
    value && typeof value !== "string",
    "Expected a listening TCP server",
  );
  return value;
}
export async function dashboard(response: Response): Promise<DashboardState> {
  assert.equal(response.status, 200);
  return JSON.parse(await response.text());
}
export type ErrorResponse = {
  error: {
    type?: string;
    message: string;
    resets_at?: string;
    plan_type?: string;
    code?: string;
  };
};
export async function errorResponse(
  response: Response,
): Promise<ErrorResponse> {
  return JSON.parse(await response.text());
}
