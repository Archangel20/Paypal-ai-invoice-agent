import { isPaymentTerm, type PaymentTerm } from "./terms";
import { isEmail } from "./validators";

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export type SplitDraft = {
  email: string;
  label: string | null;
  percent: number;
};

export type ParsedCommand =
  | { kind: "who_owes"; email?: string }
  | { kind: "income"; month?: string }
  | { kind: "clarify"; message: string }
  | {
      kind: "bill";
      clientName: string;
      clientEmail: string;
      amount: string;
      currency: string;
      description: string;
      paymentTerm: PaymentTerm;
      splits: SplitDraft[];
    };

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function parseInstruction(input: string, now = new Date()): ParsedCommand | null {
  const text = input.replace(/\s+/g, " ").trim();
  if (!text) {
    return {
      kind: "clarify",
      message: "Tell me who to bill, who still owes you, or to show this month's income.",
    };
  }

  const bill = isBill(text);
  if (!bill && isWhoOwes(text)) {
    const email = text.match(EMAIL)?.[0]?.toLowerCase();
    return email && isEmail(email) ? { kind: "who_owes", email } : { kind: "who_owes" };
  }
  if (!bill && isIncome(text)) {
    const month = extractMonth(text, now);
    return month ? { kind: "income", month } : { kind: "income" };
  }
  if (!bill) return null;

  if (
    /\b(immediately|right now|upfront|in advance)\b/i.test(text) &&
    (/\bpay\b/i.test(text) || /\d+(?:\.\d+)?\s*%/.test(text))
  ) {
    return {
      kind: "clarify",
      message:
        "Collaborator payouts go out when the client pays the invoice. Say “when they pay” to schedule that. Leave the split off if you want to pay someone from your own balance later.",
    };
  }

  const named = text.match(/\b(?:bill|invoice|charge)\s+([^()$,]+?)\s*\(\s*([^\s()]+@[^\s()]+)\s*\)/i);
  const clientEmail = (named?.[2] || text.match(EMAIL)?.[0] || "").toLowerCase();
  if (!isEmail(clientEmail)) {
    return {
      kind: "clarify",
      message: "Who should I bill? Include their name and email, like Acme (acme@example.com).",
    };
  }

  let clientName = named?.[1]?.replace(/^(?:for|to)\s+/i, "").trim() || "";
  if (!clientName) {
    const local = clientEmail.split("@")[0] || "Client";
    clientName = local.charAt(0).toUpperCase() + local.slice(1);
  }

  const amount = findAmount(text);
  if (!amount) {
    return { kind: "clarify", message: "How much should I bill? Include an amount like $1,200." };
  }

  const currency = /\b(?:eur|€)\b/i.test(text) ? "EUR" : /\b(?:gbp|£)\b/i.test(text) ? "GBP" : "USD";
  const term = findTerm(text);
  if (term.clarify) return { kind: "clarify", message: term.clarify };

  const splits = findSplits(text, clientEmail);
  if (splits.error) return { kind: "clarify", message: splits.error };

  return {
    kind: "bill",
    clientName,
    clientEmail,
    amount,
    currency,
    description: findDescription(text),
    paymentTerm: term.term,
    splits: splits.splits,
  };
}

function isBill(text: string): boolean {
  return /\b(bill|invoice|charge)\b/i.test(text);
}

function isWhoOwes(text: string): boolean {
  return (
    /\bwho\b[\s\S]{0,80}\bowes?\b/i.test(text) ||
    /\b(outstanding|unpaid)\b/i.test(text) ||
    /\bwhat(?:'s| is) owed\b/i.test(text) ||
    /\bowes?\b/i.test(text)
  );
}

function isIncome(text: string): boolean {
  return (
    /\b(income|revenue|collected|earnings)\b/i.test(text) ||
    (/\bhow much\b/i.test(text) && /\b(make|made|collect|collected|earn|earned)\b/i.test(text))
  );
}

function extractMonth(text: string, now: Date): string | undefined {
  if (/\bthis month\b/i.test(text)) return undefined;
  if (/\blast month\b/i.test(text)) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const match = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b(?:\s+(\d{4}))?/i,
  );
  if (!match) return undefined;
  const month = MONTHS[match[1].toLowerCase()];
  const year = match[2] ? Number(match[2]) : now.getUTCFullYear();
  return `${year}-${String(month).padStart(2, "0")}`;
}

function findAmount(text: string): string | null {
  const dollar = text.match(/\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (dollar) return normalizeAmount(dollar[1], dollar[2]);
  const words = text.match(/\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:usd|dollars|eur|euros|gbp|pounds)\b/i);
  if (words) return normalizeAmount(words[1], words[2]);
  const stripped = text.replace(/\bnet[-\s]?\d+\b/gi, " ").replace(/\d+(?:\.\d+)?\s*%/g, " ");
  const bare = stripped.match(/\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b/);
  if (!bare) return null;
  if (!bare[2] && bare[1].length === 4) {
    const year = Number(bare[1]);
    if (year >= 1990 && year <= 2100) return null;
  }
  return normalizeAmount(bare[1], bare[2]);
}

function normalizeAmount(whole: string, fraction?: string): string | null {
  const dollars = whole.replace(/,/g, "");
  if (!/^\d+$/.test(dollars)) return null;
  const cents = (fraction || "").padEnd(2, "0");
  if (Number(dollars) === 0 && Number(cents) === 0) return null;
  return `${Number(dollars)}.${cents}`;
}

function findDescription(text: string): string {
  const match = text.match(/\bfor\s+(.+?)(?=,|\s+net[-\s]?\d+\b|\s+and\s+pay\b|\s+due\b|$)/i);
  const raw = match?.[1]?.trim().replace(/[.,]$/, "") || "";
  if (raw.length < 2) return "Services";
  return raw.slice(0, 200);
}

function findTerm(text: string): { term: PaymentTerm; clarify?: string } {
  if (/\bdue on receipt\b|\bdue upon receipt\b|\bpayable on receipt\b/i.test(text)) {
    return { term: "DUE_ON_RECEIPT" };
  }
  const net = text.match(/\bnet[-\s]?(\d+)\b/i);
  if (!net) return { term: "DUE_ON_RECEIPT" };
  const code = `NET_${net[1]}`;
  if (!isPaymentTerm(code)) {
    return {
      term: "DUE_ON_RECEIPT",
      clarify: "I can set due on receipt, or net 10, 15, 30, 45, 60, or 90.",
    };
  }
  return { term: code };
}

function findSplits(text: string, clientEmail: string): { splits: SplitDraft[]; error?: string } {
  const found = new Map<string, SplitDraft>();
  const take = (emailRaw: string, percentRaw: string, label: string | null): string | null => {
    const email = emailRaw.toLowerCase();
    const percent = Number(percentRaw);
    if (!isEmail(email)) return `That collaborator email doesn't look right: ${emailRaw}`;
    if (!Number.isFinite(percent)) return "I couldn't read a collaborator percentage.";
    const existing = found.get(email);
    if (existing && Math.abs(existing.percent - percent) > 1e-9) {
      return `${email} was given two different percentages.`;
    }
    if (!existing) found.set(email, { email, percent, label });
    else if (!existing.label && label) existing.label = label;
    return null;
  };

  const patterns: Array<{ regex: RegExp; read: (match: RegExpMatchArray) => string | null }> = [
    {
      regex: /(?:pay\s+)?(?:my|our|the)\s+([a-z][a-z\s]{0,40}?)\s*\(\s*([^\s()]+@[^\s()]+)\s*\)\s*(\d+(?:\.\d+)?)\s*%/gi,
      read: (match) => take(match[2], match[3], cleanLabel(match[1])),
    },
    {
      regex: /(?:pay|send)\s+([^\s()]+@[^\s()]+)\s+(\d+(?:\.\d+)?)\s*%/gi,
      read: (match) => take(match[1], match[2], null),
    },
    {
      regex: /(\d+(?:\.\d+)?)\s*%\s+(?:to|for)\s+\(?\s*([^\s()]+@[^\s()]+)\s*\)?/gi,
      read: (match) => take(match[2], match[1], null),
    },
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const error = pattern.read(match);
      if (error) return { splits: [], error };
    }
  }

  const splits = [...found.values()];
  if (splits.some((split) => split.email === clientEmail)) {
    return { splits: [], error: "A collaborator split can't use the same email as the client." };
  }
  const invalid = splits.find((split) => !(split.percent > 0) || split.percent > 100);
  if (invalid) {
    return { splits: [], error: "Each collaborator percentage has to be greater than 0 and at most 100." };
  }
  const sum = splits.reduce((total, split) => total + split.percent, 0);
  if (sum > 100 + 1e-9) {
    return {
      splits: [],
      error: `Those splits add up to ${trimPercent(sum)}%. Keep the total at or under 100%.`,
    };
  }
  return { splits };
}

function cleanLabel(value: string): string | null {
  const label = value.replace(/\s+/g, " ").trim();
  if (!label || /^(pay|and|the|my|our)$/i.test(label)) return null;
  return label.slice(0, 40);
}

function trimPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
