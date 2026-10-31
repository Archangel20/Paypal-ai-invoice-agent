import { paypalConfigured } from "./config";
import { extractInvoiceId, findShareUrl } from "./events";
import { centsToDecimal } from "./money";
import { paypalRequest, PayPalError } from "./paypal";
import { dueDateFor, termLabel, type PaymentTerm } from "./terms";
import { todayUtc } from "./time";
import { callPayPalTool } from "./toolkit";
import { isRecord } from "./validators";

export type InvoiceDraft = {
  clientName: string;
  clientEmail: string;
  description: string;
  amountCents: number;
  currency: string;
  paymentTerm: PaymentTerm;
};

export type IssuedInvoice = {
  paypalInvoiceId: string;
  status: string;
  shareUrl: string | null;
  via: string;
};

// create_invoice in @paypal/agent-toolkit has no payment_term field, so net
// terms are created with Invoicing v2. Send, fetch, and record-payment still
// prefer the toolkit.
export async function issueInvoice(draft: InvoiceDraft): Promise<IssuedInvoice> {
  if (!paypalConfigured()) {
    throw new Error(
      "PayPal sandbox credentials are not set. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env.local and restart.",
    );
  }
  const due = dueDateFor(draft.paymentTerm);
  const needsTerm = draft.paymentTerm !== "DUE_ON_RECEIPT";
  const via: string[] = [];
  let paypalInvoiceId: string | null = null;

  if (!needsTerm) {
    try {
      const created = await callPayPalTool("create_invoice", toolkitCreateArgs(draft, due));
      paypalInvoiceId = extractInvoiceId(created);
      if (!paypalInvoiceId) throw new Error("Toolkit create_invoice did not return an invoice id.");
      via.push("toolkit:create_invoice");
    } catch (error) {
      via.push(`toolkit:create_invoice failed (${shortError(error)})`);
    }
  }

  if (!paypalInvoiceId) {
    const created = await paypalRequest("/v2/invoicing/invoices", {
      method: "POST",
      body: restCreateBody(draft, due),
      requestId: crypto.randomUUID(),
    });
    paypalInvoiceId = extractInvoiceId(created);
    if (!paypalInvoiceId) throw new Error("PayPal created an invoice but didn't return an id.");
    via.push(
      needsTerm
        ? "rest:create_invoice (NET terms are not on the Agent Toolkit schema)"
        : "rest:create_invoice",
    );
  }

  try {
    await callPayPalTool("send_invoice", {
      invoice_id: paypalInvoiceId,
      send_to_recipient: true,
      send_to_invoicer: true,
    });
    via.push("toolkit:send_invoice");
  } catch (error) {
    await paypalRequest(`/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}/send`, {
      method: "POST",
      body: { send_to_recipient: true, send_to_invoicer: true },
      requestId: crypto.randomUUID(),
    });
    via.push(`rest:send_invoice (toolkit: ${shortError(error)})`);
  }

  const confirmed = await fetchInvoice(paypalInvoiceId).catch(() => null);
  if (confirmed) via.push(confirmed.via);
  return {
    paypalInvoiceId,
    status: confirmed?.status || "SENT",
    shareUrl: confirmed?.shareUrl || null,
    via: via.join(" → "),
  };
}

export async function fetchInvoice(invoiceId: string): Promise<{ status: string; shareUrl: string | null; via: string }> {
  try {
    const body = await callPayPalTool("get_invoice", { invoice_id: invoiceId });
    return { status: readStatus(body) || "SENT", shareUrl: findShareUrl(body), via: "toolkit:get_invoice" };
  } catch {
    const body = await paypalRequest(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
    return { status: readStatus(body) || "SENT", shareUrl: findShareUrl(body), via: "rest:get_invoice" };
  }
}

export async function recordExternalPayment(invoiceId: string, amountCents: number, currency: string): Promise<string> {
  const args = {
    invoice_id: invoiceId,
    method: "OTHER",
    payment_date: todayUtc(),
    amount: { currency_code: currency, value: centsToDecimal(amountCents) },
    note: "Recorded by Splitnote demo mode.",
  };
  try {
    await callPayPalTool("record_payment_for_invoice", args);
    return "toolkit:record_payment_for_invoice";
  } catch (error) {
    try {
      await paypalRequest(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/payments`, {
        method: "POST",
        body: {
          method: "OTHER",
          payment_date: todayUtc(),
          amount: { currency_code: currency, value: centsToDecimal(amountCents) },
          note: "Recorded by Splitnote demo mode.",
        },
        requestId: `pay-${invoiceId}`.slice(0, 36),
      });
      return "rest:record_payment";
    } catch (restError) {
      const toolkitMessage = shortError(error);
      const restMessage = restError instanceof PayPalError ? restError.message : shortError(restError);
      throw new Error(`${restMessage} Toolkit said: ${toolkitMessage}`);
    }
  }
}

function toolkitCreateArgs(draft: InvoiceDraft, due: string): Record<string, unknown> {
  return omitEmpty({
    currency_code: draft.currency,
    invoice_date: todayUtc(),
    reference: "splitnote",
    note: invoiceNote(draft, due),
    invoicer_business_name: process.env.PAYPAL_BUSINESS_NAME,
    invoicer_given_name: process.env.PAYPAL_INVOICER_GIVEN_NAME || "Splitnote",
    invoicer_surname: process.env.PAYPAL_INVOICER_SURNAME || "Studio",
    invoicer_email_address: process.env.PAYPAL_INVOICER_EMAIL,
    primary_recipients: [
      {
        billing_info: omitEmpty({
          business_name: draft.clientName,
          email_address: draft.clientEmail,
        }),
      },
    ],
    items: [
      {
        name: draft.description.slice(0, 200),
        description: draft.description.slice(0, 1000),
        quantity: "1",
        unit_amount: { currency_code: draft.currency, value: centsToDecimal(draft.amountCents) },
      },
    ],
  });
}

function restCreateBody(draft: InvoiceDraft, due: string) {
  return {
    detail: {
      currency_code: draft.currency,
      invoice_date: todayUtc(),
      reference: "splitnote",
      note: invoiceNote(draft, due),
      payment_term: { term_type: draft.paymentTerm, due_date: due },
      payment_terms: `${termLabel(draft.paymentTerm)}. Due ${due}.`,
    },
    invoicer: omitEmpty({
      business_name: process.env.PAYPAL_BUSINESS_NAME,
      name: {
        given_name: process.env.PAYPAL_INVOICER_GIVEN_NAME || "Splitnote",
        surname: process.env.PAYPAL_INVOICER_SURNAME || "Studio",
      },
      email_address: process.env.PAYPAL_INVOICER_EMAIL,
    }),
    primary_recipients: [
      {
        billing_info: {
          business_name: draft.clientName,
          email_address: draft.clientEmail,
        },
      },
    ],
    items: [
      {
        name: draft.description.slice(0, 200),
        description: draft.description.slice(0, 1000),
        quantity: "1",
        unit_amount: { currency_code: draft.currency, value: centsToDecimal(draft.amountCents) },
      },
    ],
  };
}

function invoiceNote(draft: InvoiceDraft, due: string): string {
  return `${draft.description}. ${termLabel(draft.paymentTerm)}, due ${due}.`.slice(0, 4000);
}

function readStatus(body: unknown): string | null {
  return isRecord(body) && typeof body.status === "string" ? body.status : null;
}

function omitEmpty<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== "")) as T;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : "request failed";
  return message.replace(/\s+/g, " ").slice(0, 180);
}
