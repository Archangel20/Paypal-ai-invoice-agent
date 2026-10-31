import { createHash } from "crypto";
import {
  findInvoiceByPaypalId,
  getInvoice,
  insertEvent,
  insertPayout,
  listPayoutsForInvoice,
  markInvoicePaid,
  markInvoicePayoutFailed,
  markInvoiceSettled,
  setPaypalStatus,
  setSplitStatus,
  type DB,
} from "./db";
import { paymentReleasesPayout } from "./events";
import { fetchInvoice } from "./invoicing";
import { centsToDecimal } from "./money";
import { createPayoutBatch, type PayoutRequest, type PayoutResult } from "./paypal";
import type { ChatStep, InvoiceView } from "./types";

export type SettleInput = {
  eventId: string;
  eventType: string;
  source: "paypal" | "demo" | "sync" | "retry";
  verified: boolean;
  paypalInvoiceId?: string | null;
  localInvoiceId?: string | null;
  status?: string | null;
  payload?: unknown;
};

export type SettleResult = {
  outcome: "settled" | "already_settled" | "waiting" | "ignored" | "failed" | "no_invoice";
  steps: ChatStep[];
  invoice: InvoiceView | null;
  inserted: boolean;
};

type Deps = {
  createPayout: (request: PayoutRequest) => Promise<PayoutResult>;
  lookupStatus: (paypalInvoiceId: string) => Promise<string | undefined>;
};

const defaultDeps: Deps = {
  createPayout: createPayoutBatch,
  lookupStatus: async (paypalInvoiceId) => (await fetchInvoice(paypalInvoiceId)).status,
};

const ACTIVE_BLOCK = new Set(["FAILED", "DENIED", "CANCELED", "CANCELLED", "RETURNED", "BLOCKED"]);

export async function settlePaidInvoice(db: DB, input: SettleInput, deps: Deps = defaultDeps): Promise<SettleResult> {
  const invoice = input.localInvoiceId
    ? getInvoice(db, input.localInvoiceId)
    : input.paypalInvoiceId
      ? findInvoiceByPaypalId(db, input.paypalInvoiceId)
      : null;

  if (!invoice) {
    const inserted = insertEvent(db, {
      id: input.eventId,
      eventType: input.eventType,
      invoiceId: null,
      source: input.source,
      verified: input.verified,
      summary: `No Splitnote invoice matches this ${input.eventType} event.`,
      payload: input.payload ?? null,
    });
    return {
      outcome: "no_invoice",
      invoice: null,
      inserted,
      steps: [
        {
          tone: "neutral",
          title: "No matching invoice",
          body: "PayPal sent an event for an invoice that Splitnote didn't create, so no payout was sent.",
        },
      ],
    };
  }

  let status = input.status || null;
  if (!status && input.source === "paypal" && invoice.paypalInvoiceId) {
    try {
      status = (await deps.lookupStatus(invoice.paypalInvoiceId)) || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "PayPal didn't return a status.";
      return finish(db, input, invoice, "waiting", [
        {
          tone: "wait",
          title: "Payment not confirmed",
          body: `I couldn't confirm ${invoice.paypalInvoiceId} is paid, so the collaborator payout is still waiting. ${message}`,
        },
      ]);
    }
  }

  const decision = paymentReleasesPayout(status, input.source);
  if (status) setPaypalStatus(db, invoice.id, status);
  if (decision === "wait") {
    return finish(db, input, invoice, "waiting", [
      {
        tone: "wait",
        title: "Payout held",
        body: `${invoice.clientName}'s invoice is ${status || "not fully paid"}. Collaborator splits stay put until PayPal reports PAID.`,
      },
    ]);
  }
  if (decision === "ignore") {
    return finish(db, input, invoice, "ignored", []);
  }

  const existing = listPayoutsForInvoice(db, invoice.id);
  const active = existing.some((payout) => !ACTIVE_BLOCK.has(payout.status.toUpperCase()));
  if (invoice.status === "settled" || active) {
    return finish(db, input, invoice, "already_settled", [
      {
        tone: "neutral",
        title: "Already settled",
        body: `${invoice.paypalInvoiceId} already has a payout, so I didn't send another one.`,
      },
    ]);
  }

  markInvoicePaid(db, invoice.id, status);
  if (invoice.splits.length === 0) {
    markInvoiceSettled(db, invoice.id);
    return finish(db, input, getInvoice(db, invoice.id), "settled", [
      {
        tone: "good",
        title: "Invoice paid",
        body: `${invoice.clientName} paid ${invoice.paypalInvoiceId}. No collaborator split was stored, so there is nothing to pay out.`,
      },
    ]);
  }

  const request = payoutRequest(invoice);
  try {
    const result = await deps.createPayout(request);
    for (const item of request.items) {
      const split = invoice.splits.find((entry) => entry.email === item.receiver);
      insertPayout(db, {
        invoiceId: invoice.id,
        paypalBatchId: result.payoutBatchId,
        senderBatchId: request.senderBatchId,
        recipientEmail: item.receiver,
        amountCents: split?.amountCents || 0,
        currency: invoice.currency,
        status: result.status,
        note: item.note,
        raw: result.raw,
      });
    }
    setSplitStatus(db, invoice.id, "submitted");
    markInvoiceSettled(db, invoice.id);
    const names = invoice.splits
      .map((split) => `${split.email} ${centsToDecimal(split.amountCents)} ${invoice.currency}`)
      .join(", ");
    return finish(db, input, getInvoice(db, invoice.id), "settled", [
      {
        tone: "good",
        title: "Payout batch submitted",
        body: `PayPal accepted payout batch ${result.payoutBatchId || "(no id)"} (${result.status}) for ${names}. Funds leave the sandbox balance when the batch clears.`,
        via: "rest:POST /v1/payments/payouts",
      },
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payout failed.";
    markInvoicePayoutFailed(db, invoice.id, message);
    return finish(db, input, getInvoice(db, invoice.id), "failed", [
      {
        tone: "bad",
        title: "Payout failed",
        body: `${invoice.clientName}'s payment is recorded, but the collaborator payout didn't go through. ${message}`,
        via: "rest:POST /v1/payments/payouts",
      },
    ]);
  }
}

function finish(
  db: DB,
  input: SettleInput,
  invoice: InvoiceView | null,
  outcome: SettleResult["outcome"],
  steps: ChatStep[],
): SettleResult {
  const inserted = insertEvent(db, {
    id: input.eventId,
    eventType: input.eventType,
    invoiceId: invoice?.id || null,
    source: input.source,
    verified: input.verified,
    summary: steps[0]?.body || outcome,
    payload: input.payload ?? null,
  });
  return { outcome, steps, inserted, invoice: invoice?.id ? getInvoice(db, invoice.id) : invoice };
}

function payoutRequest(invoice: InvoiceView): PayoutRequest {
  return {
    senderBatchId: senderBatchId(invoice.id),
    currency: invoice.currency,
    subject: "You have a payout from Splitnote",
    items: invoice.splits.map((split) => ({
      receiver: split.email,
      amount: centsToDecimal(split.amountCents),
      senderItemId: senderItemId(invoice.id, split.email),
      note: `${trimPercent(split.percent)}% of ${invoice.description}`.slice(0, 400),
    })),
  };
}

export function senderBatchId(invoiceId: string): string {
  return `sn${createHash("sha256").update(invoiceId).digest("hex").slice(0, 20)}`;
}

function senderItemId(invoiceId: string, email: string): string {
  return `si${createHash("sha256").update(`${invoiceId}:${email}`).digest("hex").slice(0, 20)}`;
}

function trimPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
