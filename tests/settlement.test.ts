import assert from "node:assert/strict";
import test from "node:test";
import { getInvoice, insertInvoice, openDatabase } from "../src/lib/db";
import { settlePaidInvoice } from "../src/lib/settlement";
import type { PayoutRequest, PayoutResult } from "../src/lib/paypal";

function seed() {
  const db = openDatabase(":memory:");
  const invoice = insertInvoice(
    db,
    {
      paypalInvoiceId: "INV2-TEST-TEST-TEST-TEST",
      clientName: "Acme",
      clientEmail: "acme@example.com",
      description: "the October logo work",
      amountCents: 120000,
      currency: "USD",
      paymentTerm: "NET_15",
      dueDate: "2026-11-15",
      status: "sent",
      paypalStatus: "SENT",
      shareUrl: null,
      via: "test",
    },
    [{ email: "designer@example.com", label: "designer", percent: 30, amountCents: 36000 }],
  );
  return { db, invoice };
}

test("a paid invoice sends one payout and ignores a second event", async () => {
  const { db, invoice } = seed();
  const requests: PayoutRequest[] = [];
  const deps = {
    createPayout: async (request: PayoutRequest): Promise<PayoutResult> => {
      requests.push(request);
      return { payoutBatchId: "BATCH-1", status: "PENDING", raw: { batch_header: { payout_batch_id: "BATCH-1" } } };
    },
    lookupStatus: async () => "PAID",
  };
  const first = await settlePaidInvoice(
    db,
    {
      eventId: "evt-1",
      eventType: "INVOICING.INVOICE.PAID",
      source: "demo",
      verified: false,
      localInvoiceId: invoice.id,
      status: "PAID",
    },
    deps,
  );
  assert.equal(first.outcome, "settled");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].items[0].receiver, "designer@example.com");
  assert.equal(requests[0].items[0].amount, "360.00");
  assert.equal(requests[0].currency, "USD");

  const second = await settlePaidInvoice(
    db,
    {
      eventId: "evt-2",
      eventType: "INVOICING.INVOICE.PAID",
      source: "paypal",
      verified: true,
      paypalInvoiceId: invoice.paypalInvoiceId,
      status: "PAID",
    },
    deps,
  );
  assert.equal(second.outcome, "already_settled");
  assert.equal(requests.length, 1);
  assert.equal(getInvoice(db, invoice.id)?.status, "settled");
});

test("partial payment does not release the split", async () => {
  const { db, invoice } = seed();
  let calls = 0;
  const result = await settlePaidInvoice(
    db,
    {
      eventId: "evt-partial",
      eventType: "INVOICING.INVOICE.PAID",
      source: "paypal",
      verified: true,
      localInvoiceId: invoice.id,
      status: "PARTIALLY_PAID",
    },
    {
      createPayout: async () => {
        calls += 1;
        return { payoutBatchId: "NO", status: "PENDING", raw: {} };
      },
      lookupStatus: async () => "PARTIALLY_PAID",
    },
  );
  assert.equal(result.outcome, "waiting");
  assert.equal(calls, 0);
  assert.equal(getInvoice(db, invoice.id)?.status, "sent");
});

test("a failed payout can be retried", async () => {
  const { db, invoice } = seed();
  let calls = 0;
  const deps = {
    createPayout: async (): Promise<PayoutResult> => {
      calls += 1;
      if (calls === 1) throw new Error("INSUFFICIENT_FUNDS");
      return { payoutBatchId: "BATCH-2", status: "PENDING", raw: {} };
    },
    lookupStatus: async () => "PAID",
  };
  const failed = await settlePaidInvoice(
    db,
    { eventId: "evt-fail", eventType: "INVOICING.INVOICE.PAID", source: "demo", verified: false, localInvoiceId: invoice.id, status: "PAID" },
    deps,
  );
  assert.equal(failed.outcome, "failed");
  assert.equal(getInvoice(db, invoice.id)?.status, "payout_failed");

  const retried = await settlePaidInvoice(
    db,
    { eventId: "evt-retry", eventType: "INVOICING.INVOICE.PAID", source: "retry", verified: false, localInvoiceId: invoice.id, status: "PAID" },
    deps,
  );
  assert.equal(retried.outcome, "settled");
  assert.equal(calls, 2);
  assert.equal(getInvoice(db, invoice.id)?.status, "settled");
});
