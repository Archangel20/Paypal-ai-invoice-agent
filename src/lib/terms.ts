export const PAYMENT_TERMS = [
  "DUE_ON_RECEIPT",
  "NET_10",
  "NET_15",
  "NET_30",
  "NET_45",
  "NET_60",
  "NET_90",
] as const;

export type PaymentTerm = (typeof PAYMENT_TERMS)[number];

const TERM_DAYS: Record<PaymentTerm, number> = {
  DUE_ON_RECEIPT: 0,
  NET_10: 10,
  NET_15: 15,
  NET_30: 30,
  NET_45: 45,
  NET_60: 60,
  NET_90: 90,
};

export function isPaymentTerm(value: string): value is PaymentTerm {
  return (PAYMENT_TERMS as readonly string[]).includes(value);
}

export function termLabel(term: string): string {
  if (term === "DUE_ON_RECEIPT") return "Due on receipt";
  if (term.startsWith("NET_")) return `Net ${term.slice(4)}`;
  return term;
}

export function dueDateFor(term: PaymentTerm, issued = new Date()): string {
  const days = TERM_DAYS[term];
  const date = new Date(Date.UTC(issued.getUTCFullYear(), issued.getUTCMonth(), issued.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
