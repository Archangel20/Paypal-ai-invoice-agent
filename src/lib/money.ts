import { isEmail } from "./validators";

export type SplitInput = {
  email: string;
  label?: string | null;
  percent: number;
};

export type SplitLine = {
  email: string;
  label: string | null;
  percent: number;
  amountCents: number;
};

const MAX_INVOICE_CENTS = 1_000_000_000;

export function dollarsToCents(amount: number | string): number {
  const raw = typeof amount === "number" ? amount.toFixed(2) : amount.trim().replace(/[$,\s]/g, "");
  const match = raw.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("Amount must be a positive dollar value, like 1200 or 1200.50.");
  const cents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error("Amount must be greater than zero.");
  }
  if (cents > MAX_INVOICE_CENTS) {
    throw new Error("That amount is above this studio's $10,000,000 invoice cap.");
  }
  return cents;
}

export function centsToDecimal(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const sign = cents < 0 ? "-" : "";
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${centsToDecimal(cents)} ${currency}`;
  }
}

/**
 * Each split is rounded to the nearest cent. If rounding would pay out more
 * than the invoice, the last collaborator absorbs the difference.
 */
export function calculateSplits(totalCents: number, splits: SplitInput[]): SplitLine[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new Error("Invoice total must be a positive number of cents.");
  }
  if (splits.length === 0) return [];
  if (splits.length > 15) {
    throw new Error("Splitnote can pay at most 15 collaborators on one invoice.");
  }

  const seen = new Set<string>();
  let percentSum = 0;
  for (const split of splits) {
    const email = split.email.trim().toLowerCase();
    if (!isEmail(email)) throw new Error(`Invalid collaborator email: ${split.email}`);
    if (seen.has(email)) throw new Error(`Duplicate collaborator: ${email}`);
    seen.add(email);
    if (!(split.percent > 0) || split.percent > 100) {
      throw new Error("Each collaborator percentage must be greater than 0 and at most 100.");
    }
    percentSum += split.percent;
  }
  if (percentSum > 100 + 1e-9) {
    throw new Error("Collaborator percentages must total at most 100.");
  }

  const lines: SplitLine[] = splits.map((split) => ({
    email: split.email.trim().toLowerCase(),
    label: split.label?.trim() || null,
    percent: split.percent,
    amountCents: Math.round((totalCents * split.percent) / 100),
  }));

  const payout = lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (payout > totalCents) {
    lines[lines.length - 1].amountCents -= payout - totalCents;
  }
  if (lines.some((line) => line.amountCents < 1)) {
    throw new Error("A collaborator split rounds to $0.00. Raise the invoice amount or the percentage.");
  }
  return lines;
}
