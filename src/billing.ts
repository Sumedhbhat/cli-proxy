// Actual spending comes only from billing records the user enters or imports.
// Nothing here is derived from token counts.
import type { BillingInput } from "./ledger.ts";

export const BILLING_KINDS = [
  "subscription", // a plan fee, for example a monthly Claude or ChatGPT plan
  "credit_purchase", // money paid for prepaid credits
  "usage_charge", // metered usage billed in money
  "credit_consumption", // usage paid from prepaid credits: not new spending
  "refund",
  "adjustment",
] as const;
export type BillingKind = (typeof BILLING_KINDS)[number];

const day = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value: string) =>
  day.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Splits RFC 4180 CSV, including quoted fields with commas and quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

// Two-decimal currencies only; exact minor units avoid floating-point sums.
export function parseAmount(value: string): number | null {
  const match = /^(-)?(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const minor =
    Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -minor : minor;
}

const clean = (value: string | undefined, limit: number) => {
  const text = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, limit);
  return text || null;
};

export function validateBilling(
  input: Record<string, string | undefined>,
): BillingInput | string {
  const kind = (input.kind ?? "").trim() as BillingKind;
  if (!BILLING_KINDS.includes(kind))
    return `kind must be one of ${BILLING_KINDS.join(", ")}`;
  const provider = (input.provider ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(provider)) return "provider is required";
  const occurredOn = (input.date ?? "").trim();
  if (!validDay(occurredOn)) return "date must be YYYY-MM-DD";
  const amountMinor = parseAmount(input.amount ?? "");
  if (amountMinor === null || amountMinor < 0)
    return "amount must be a non-negative number with at most two decimals";
  const currency = (input.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    return "currency must be a three-letter code";
  const periodStart = clean(input.period_start, 10);
  const periodEnd = clean(input.period_end, 10);
  if (
    (periodStart && !validDay(periodStart)) ||
    (periodEnd && !validDay(periodEnd))
  )
    return "period dates must be YYYY-MM-DD";
  if (periodStart && periodEnd && periodEnd < periodStart)
    return "period_end is before period_start";
  return {
    kind,
    provider,
    account: clean(input.account, 200),
    amountMinor,
    currency,
    occurredOn,
    periodStart,
    periodEnd,
    description: clean(input.description, 200),
  };
}

export function parseBillingCsv(text: string) {
  const [header, ...body] = parseCsv(text.replace(/^﻿/, ""));
  const columns = (header ?? []).map((name) => name.trim().toLowerCase());
  const missing = ["date", "kind", "provider", "amount", "currency"].filter(
    (c) => !columns.includes(c),
  );
  if (missing.length)
    return { records: [], errors: [`Missing columns: ${missing.join(", ")}`] };
  const records: BillingInput[] = [];
  const errors: string[] = [];
  body.forEach((values, index) => {
    const result = validateBilling(
      Object.fromEntries(columns.map((c, i) => [c, values[i]])),
    );
    if (typeof result === "string") errors.push(`Row ${index + 2}: ${result}`);
    else records.push(result);
  });
  if (!body.length) errors.push("No billing rows");
  return { records, errors };
}

export interface SpendingRecord {
  readonly kind: string;
  readonly currency: string;
  readonly amountMinor: number;
}

/**
 * Spending is cash paid: plan fees, credit purchases, and metered charges,
 * less refunds. Credit consumption only draws down credits already counted
 * at purchase, so it is reported separately and never added to spending.
 */
export function summarizeSpending(records: ReadonlyArray<SpendingRecord>) {
  const out: Record<string, Record<BillingKind | "spend", number>> = {};
  for (const r of records) {
    const totals = (out[r.currency] ??= {
      spend: 0,
      subscription: 0,
      credit_purchase: 0,
      usage_charge: 0,
      credit_consumption: 0,
      refund: 0,
      adjustment: 0,
    });
    const kind = r.kind as BillingKind;
    if (!(kind in totals)) continue;
    totals[kind] += r.amountMinor;
    if (kind === "refund") totals.spend -= r.amountMinor;
    else if (kind !== "credit_consumption") totals.spend += r.amountMinor;
  }
  return out;
}
