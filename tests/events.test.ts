import assert from "node:assert/strict";
import test from "node:test";
import { extractInvoiceId, findShareUrl, paymentReleasesPayout, readInvoiceEvent } from "../src/lib/events";
import { interpretToolkitPayload } from "../src/lib/toolkit";
import { senderBatchId } from "../src/lib/settlement";

test("invoice paid events are read from nested and flat resources", () => {
  const nested = readInvoiceEvent({
    id: "WH-1",
    event_type: "INVOICING.INVOICE.PAID",
    resource: { invoice: { id: "INV2-AAAA-BBBB-CCCC-DDDD", status: "PAID" } },
  });
  assert.equal(nested.invoiceId, "INV2-AAAA-BBBB-CCCC-DDDD");
  assert.equal(nested.status, "PAID");

  const flat = readInvoiceEvent({
    event_type: "INVOICING.INVOICE.PAID",
    resource: { id: "INV2-EEEE-FFFF-GGGG-HHHH", status: "PARTIALLY_PAID" },
  });
  assert.equal(flat.invoiceId, "INV2-EEEE-FFFF-GGGG-HHHH");
  assert.equal(paymentReleasesPayout(flat.status, "paypal"), "wait");
  assert.equal(paymentReleasesPayout("PAID", "paypal"), "release");
  assert.equal(paymentReleasesPayout(null, "paypal"), "wait");
  assert.equal(paymentReleasesPayout(null, "demo"), "release");
});

test("share links skip API urls and invoice ids survive a link-only create response", () => {
  const body = {
    href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-ZZZZ-YYYY-XXXX-WWWW",
    links: [{ href: "https://www.sandbox.paypal.com/invoice/payerView/details/INV2-ZZZZ-YYYY-XXXX-WWWW", rel: "payer-view" }],
  };
  assert.equal(extractInvoiceId(body), "INV2-ZZZZ-YYYY-XXXX-WWWW");
  assert.match(findShareUrl(body) || "", /payerView/);
});

test("toolkit error payloads become exceptions and successes pass through", () => {
  assert.throws(() => interpretToolkitPayload(JSON.stringify({ error: { message: "Invoice not found", type: "paypal_error" } })), /Invoice not found/);
  const invoice = interpretToolkitPayload({ id: "INV2-TEST-TEST-TEST-TEST", status: "DRAFT" }) as { id: string };
  assert.equal(invoice.id, "INV2-TEST-TEST-TEST-TEST");
});

test("payout sender batch ids stay short enough for PayPal", () => {
  const id = senderBatchId("11111111-1111-1111-1111-111111111111");
  assert.match(id, /^sn[a-f0-9]{20}$/);
  assert.ok(id.length <= 30);
});
