import { demoModeEnabled, paypalConfigured } from "./config";
import {
  addMessage,
  ensureConversation,
  findInvoiceByPaypalId,
  getInvoice,
  insertEvent,
  insertInvoice,
  latestConversationId,
  listInvoices,
  paidOutCents,
  setPaypalStatus,
  updatePayoutsByBatch,
  type DB,
} from "./db";
import { extractPayoutBatch, paymentReleasesPayout, readInvoiceEvent } from "./events";
import { fetchInvoice, issueInvoice, recordExternalPayment } from "./invoicing";
import { calculateSplits, dollarsToCents, formatMoney } from "./money";
import type { ParsedCommand } from "./parseInstruction";
import { settlePaidInvoice } from "./settlement";
import { dueDateFor, isPaymentTerm, termLabel, type PaymentTerm } from "./terms";
import { currentMonth, formatDay, parseMonth } from "./time";
import type { ChatStep, InvoiceView, ToolPayload } from "./types";
import { isEmail, isRecord } from "./validators";
import { snapshot } from "./view";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type BillInput = {
  clientName: string;
  clientEmail: string;
  amount: number | string;
  currency?: string;
  description: string;
  paymentTerm?: string;
  collaborators?: { email: string; label?: string; percent: number }[];
};

export async function billClient(db: DB, input: BillInput): Promise<ToolPayload> {
  try {
    const currency = (input.currency || "USD").toUpperCase();
    if (!["USD", "EUR", "GBP"].includes(currency)) return fail("Use USD, EUR, or GBP.");
    const termValue = input.paymentTerm || "DUE_ON_RECEIPT";
    if (!isPaymentTerm(termValue)) {
      return fail("Payment terms must be due on receipt, or net 10, 15, 30, 45, 60, or 90.");
    }
    if (!input.clientName.trim()) return fail("I need the client's name.");
    if (!isEmail(input.clientEmail)) return fail("The client email doesn't look valid.");
    const clientEmail = input.clientEmail.trim().toLowerCase();
    const description = input.description.trim().slice(0, 200) || "Services";
    const amountCents = dollarsToCents(input.amount);
    const collaborators = input.collaborators || [];
    if (collaborators.some((collaborator) => collaborator.email.trim().toLowerCase() === clientEmail)) {
      return fail("A collaborator split can't use the same email as the client.");
    }
    const splits = calculateSplits(
      amountCents,
      collaborators.map((collaborator) => ({
        email: collaborator.email,
        label: collaborator.label,
        percent: collaborator.percent,
      })),
    );
    const due = dueDateFor(termValue);
    const issued = await issueInvoice({
      clientName: input.clientName.trim(),
      clientEmail,
      description,
      amountCents,
      currency,
      paymentTerm: termValue,
    });
    const saved = insertInvoice(
      db,
      {
        paypalInvoiceId: issued.paypalInvoiceId,
        clientName: input.clientName.trim(),
        clientEmail,
        description,
        amountCents,
        currency,
        paymentTerm: termValue,
        dueDate: due,
        status: "sent",
        paypalStatus: issued.status,
        shareUrl: issued.shareUrl,
        via: issued.via,
      },
      splits,
    );
    return ok(billSummary(saved, termValue, splits.length ? splits : saved.splits), billSteps(saved, termValue));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "I couldn't create the invoice.", "Invoice failed");
  }
}

export function whoOwes(db: DB, email?: string): ToolPayload {
  const needle = email?.trim().toLowerCase();
  const open = listInvoices(db).filter((invoice) => invoice.status === "sent" && (!needle || invoice.clientEmail === needle));
  if (open.length === 0) {
    const summary = needle ? `Nobody matching ${needle} has an open invoice.` : "Nobody has an open invoice.";
    return ok(summary, [{ tone: "good", title: "Nothing outstanding", body: summary }]);
  }
  const total = open.reduce((sum, invoice) => sum + invoice.amountCents, 0);
  const currency = open[0]?.currency || "USD";
  const lines = open.map(
    (invoice) =>
      `${invoice.clientName} (${invoice.clientEmail}) owes ${formatMoney(invoice.amountCents, invoice.currency)} for ${invoice.description}, due ${formatDay(invoice.dueDate)}. ${invoice.paypalInvoiceId}.`,
  );
  const summary = `Still open: ${lines.join(" ")} Outstanding total ${formatMoney(total, currency)}.`;
  return ok(summary, [
    {
      tone: "wait",
      title: `${open.length} open invoice${open.length === 1 ? "" : "s"}`,
      body: `${lines.join(" ")} Outstanding total ${formatMoney(total, currency)}.`,
    },
  ]);
}

export function monthlyIncome(db: DB, month?: string): ToolPayload {
  let key: string;
  try {
    key = parseMonth(month);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "I couldn't read that month.");
  }
  const invoices = listInvoices(db).filter(
    (invoice) => invoice.paidAt?.startsWith(key) && ["paid", "settled", "payout_failed"].includes(invoice.status),
  );
  const collected = invoices.reduce((sum, invoice) => sum + invoice.amountCents, 0);
  const currency = invoices[0]?.currency || "USD";
  const paidOut = paidOutCents(db, key);
  const label = key === currentMonth() ? "this month" : key;
  const period = label === "this month" ? "this month" : `in ${label}`;
  if (invoices.length === 0) {
    const summary = `No client payments were collected ${period}. Collaborator payouts sent: ${formatMoney(paidOut, currency)}.`;
    return ok(summary, [{ tone: "neutral", title: `Income for ${label}`, body: summary }]);
  }
  const lines = invoices.map(
    (invoice) => `${invoice.clientName} paid ${formatMoney(invoice.amountCents, invoice.currency)} (${invoice.paypalInvoiceId})`,
  );
  const summary = `Collected ${formatMoney(collected, currency)} ${period} from ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}. ${lines.join("; ")}. Collaborator payouts: ${formatMoney(paidOut, currency)}.`;
  return ok(summary, [
    {
      tone: "good",
      title: `Income for ${label}`,
      body: summary,
    },
  ]);
}

export async function runParsed(db: DB, parsed: ParsedCommand): Promise<ToolPayload> {
  if (parsed.kind === "clarify") return fail(parsed.message, "Need a detail");
  if (parsed.kind === "who_owes") return whoOwes(db, parsed.email);
  if (parsed.kind === "income") return monthlyIncome(db, parsed.month);
  return billClient(db, {
    clientName: parsed.clientName,
    clientEmail: parsed.clientEmail,
    amount: parsed.amount,
    currency: parsed.currency,
    description: parsed.description,
    paymentTerm: parsed.paymentTerm,
    collaborators: parsed.splits.map((split) => ({
      email: split.email,
      label: split.label || undefined,
      percent: split.percent,
    })),
  });
}

export function toolForCommand(parsed: ParsedCommand | null): string | null {
  if (!parsed) return null;
  if (parsed.kind === "bill") return "bill_client";
  if (parsed.kind === "who_owes") return "who_owes_me";
  if (parsed.kind === "income") return "monthly_income";
  return null;
}

export async function simulatePayment(db: DB, localInvoiceId: string, conversationId?: string) {
  if (!demoModeEnabled()) {
    throw new HttpError(403, "Demo mode is off. Set DEMO_MODE=true only on a private sandbox.");
  }
  const invoice = getInvoice(db, localInvoiceId);
  if (!invoice) throw new HttpError(404, "That invoice isn't in the ledger.");
  const steps: ChatStep[] = [
    {
      tone: "neutral",
      title: "Simulated INVOICING.INVOICE.PAID",
      body: "Demo mode is standing in for a PayPal webhook, so this works without a public URL. The payout call is still the real Payouts API.",
    },
  ];
  if (paypalConfigured() && invoice.status !== "settled") {
    try {
      const via = await recordExternalPayment(invoice.paypalInvoiceId, invoice.amountCents, invoice.currency);
      setPaypalStatus(db, invoice.id, "PAID");
      steps.push({
        tone: "good",
        title: "Marked paid in PayPal",
        body: `Recorded an external payment on ${invoice.paypalInvoiceId} so the sandbox invoice shows as paid.`,
        via,
      });
    } catch (error) {
      steps.push({
        tone: "wait",
        title: "Sandbox invoice left unpaid",
        body: `${error instanceof Error ? error.message : "PayPal rejected the payment record."} The collaborator payout still runs from this simulated paid event.`,
      });
    }
  }
  const result = await settlePaidInvoice(db, {
    eventId: `demo-${crypto.randomUUID()}`,
    eventType: "INVOICING.INVOICE.PAID",
    source: "demo",
    verified: false,
    localInvoiceId: invoice.id,
    paypalInvoiceId: invoice.paypalInvoiceId,
    status: "PAID",
    payload: {
      id: "demo",
      event_type: "INVOICING.INVOICE.PAID",
      resource: { invoice: { id: invoice.paypalInvoiceId, status: "PAID" } },
    },
  });
  const all = [...steps, ...result.steps];
  const convo = ensureConversation(db, conversationId);
  addMessage(db, {
    conversationId: convo,
    role: "assistant",
    content: all.map((step) => step.body).join(" "),
    steps: all,
    engine: "demo",
  });
  return snapshot(db, convo);
}

export async function syncFromPayPal(db: DB, conversationId?: string) {
  if (!paypalConfigured()) {
    return { ...(await snapshot(db, conversationId)), notice: "Add PayPal credentials before syncing." };
  }
  const open = listInvoices(db).filter((invoice) => invoice.status === "sent" || invoice.status === "payout_failed");
  let settled = 0;
  const problems: string[] = [];
  for (const invoice of open.slice(0, 20)) {
    try {
      const remote = await fetchInvoice(invoice.paypalInvoiceId);
      setPaypalStatus(db, invoice.id, remote.status, remote.shareUrl);
      if (paymentReleasesPayout(remote.status, "sync") !== "release") continue;
      const result = await settlePaidInvoice(db, {
        eventId: `sync-${invoice.id}-${remote.status}`,
        eventType: "INVOICING.INVOICE.PAID",
        source: "sync",
        verified: true,
        localInvoiceId: invoice.id,
        paypalInvoiceId: invoice.paypalInvoiceId,
        status: remote.status,
        payload: { source: "sync", status: remote.status },
      });
      if ((result.outcome === "settled" || result.outcome === "failed") && result.inserted) {
        remember(db, conversationId, result.steps, "paypal-sync");
        if (result.outcome === "settled") settled += 1;
      }
    } catch (error) {
      problems.push(`${invoice.paypalInvoiceId}: ${error instanceof Error ? error.message : "sync failed"}`);
    }
  }
  const notice = problems.length
    ? `Checked ${open.length} invoice${open.length === 1 ? "" : "s"}. Settled ${settled}. ${problems[0]}`
    : open.length === 0
      ? "No open invoices to check."
      : `Checked ${open.length} invoice${open.length === 1 ? "" : "s"} on PayPal. ${settled} newly settled.`;
  return { ...(await snapshot(db, conversationId)), notice };
}

export async function handleIncomingPayPalEvent(db: DB, event: unknown, verified: boolean) {
  const eventId = isRecord(event) && typeof event.id === "string" ? event.id : crypto.randomUUID();
  const eventType = isRecord(event) && typeof event.event_type === "string" ? event.event_type : "UNKNOWN";

  if (eventType.startsWith("PAYMENT.PAYOUT")) {
    const batch = extractPayoutBatch(event);
    const summary = batch
      ? updatePayoutsByBatch(db, batch.batchId, batch.status)
        ? `Payout batch ${batch.batchId} is now ${batch.status}.`
        : `Payout batch ${batch.batchId} is ${batch.status}. No local payout matched it.`
      : "PayPal sent a payout update without a batch id.";
    const inserted = insertEvent(db, {
      id: eventId,
      eventType,
      invoiceId: null,
      source: "paypal",
      verified,
      summary,
      payload: event,
    });
    if (inserted) {
      remember(db, undefined, [{ tone: "neutral", title: "Payout update", body: summary }], "paypal-webhook");
    }
    return { outcome: "ignored" as const };
  }

  if (eventType !== "INVOICING.INVOICE.PAID") {
    insertEvent(db, {
      id: eventId,
      eventType,
      invoiceId: null,
      source: "paypal",
      verified,
      summary: `Ignored ${eventType}.`,
      payload: event,
    });
    return { outcome: "ignored" as const };
  }

  const parsed = readInvoiceEvent(event);
  const known = parsed.invoiceId ? findInvoiceByPaypalId(db, parsed.invoiceId) : null;
  const result = await settlePaidInvoice(db, {
    eventId,
    eventType,
    source: "paypal",
    verified,
    paypalInvoiceId: parsed.invoiceId,
    localInvoiceId: known?.id,
    status: parsed.status,
    payload: event,
  });
  if (result.inserted && result.steps.length && result.outcome !== "ignored" && result.outcome !== "already_settled") {
    remember(db, undefined, result.steps, "paypal-webhook");
  }
  return result;
}

function remember(db: DB, conversationId: string | undefined, steps: ChatStep[], engine: string) {
  if (steps.length === 0) return;
  const convo = conversationId ? ensureConversation(db, conversationId) : latestConversationId(db);
  addMessage(db, {
    conversationId: convo,
    role: "assistant",
    content: steps.map((step) => step.body).join(" "),
    steps,
    engine,
  });
}

function billSummary(invoice: InvoiceView, term: PaymentTerm, splits: { email: string; label: string | null; percent: number; amountCents: number }[]): string {
  const money = formatMoney(invoice.amountCents, invoice.currency);
  const splitText = splits.length
    ? ` When it's paid, ${splits
        .map(
          (split) =>
            `${split.label ? `${split.label} ` : ""}${split.email} receives ${formatMoney(split.amountCents, invoice.currency)} (${trimPercent(split.percent)}%)`,
        )
        .join("; ")}.`
    : " No collaborator split was requested.";
  return `I sent ${invoice.clientName} (${invoice.clientEmail}) a ${money} PayPal invoice for ${invoice.description}. Terms are ${termLabel(term)}, due ${formatDay(invoice.dueDate)}. PayPal id ${invoice.paypalInvoiceId}.${splitText}`;
}

function billSteps(invoice: InvoiceView, term: PaymentTerm): ChatStep[] {
  const money = formatMoney(invoice.amountCents, invoice.currency);
  const steps: ChatStep[] = [
    {
      tone: "good",
      title: "Invoice sent",
      body: `${invoice.paypalInvoiceId} to ${invoice.clientEmail} for ${money}, ${termLabel(term).toLowerCase()}, due ${formatDay(invoice.dueDate)}.`,
      via: invoice.via,
    },
  ];
  if (invoice.splits.length) {
    steps.push({
      tone: "good",
      title: "Split saved",
      body: invoice.splits
        .map(
          (split) =>
            `${split.email} gets ${formatMoney(split.amountCents, invoice.currency)} (${trimPercent(split.percent)}%) after the client pays.`,
        )
        .join(" "),
    });
    steps.push({
      tone: "wait",
      title: "Waiting for INVOICING.INVOICE.PAID",
      body: "Nothing goes to collaborators until PayPal reports this invoice paid. Use Simulate payment on the card if you don't have a public webhook URL.",
    });
  }
  return steps;
}

function trimPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function ok(summary: string, steps: ChatStep[]): ToolPayload {
  return { ok: true, summary, steps };
}

function fail(summary: string, title = "Couldn't do that"): ToolPayload {
  return { ok: false, summary, steps: [{ tone: "bad", title, body: summary }] };
}
