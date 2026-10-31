import { isRecord } from "./validators";

export type ReleaseDecision = "release" | "wait" | "ignore";

export function paymentReleasesPayout(
  status: string | null | undefined,
  source: "paypal" | "demo" | "sync" | "retry",
): ReleaseDecision {
  if (!status) return source === "demo" || source === "retry" ? "release" : "wait";
  const normalized = status.toUpperCase();
  if (normalized === "PAID" || normalized === "MARKED_AS_PAID") return "release";
  if (
    normalized === "PARTIALLY_PAID" ||
    normalized === "PAYMENT_PENDING" ||
    normalized === "UNPAID" ||
    normalized === "SENT" ||
    normalized === "SCHEDULED" ||
    normalized === "DRAFT"
  ) {
    return "wait";
  }
  return "ignore";
}

export function readInvoiceEvent(event: unknown): {
  eventType: string | null;
  invoiceId: string | null;
  status: string | null;
} {
  if (!isRecord(event)) return { eventType: null, invoiceId: null, status: null };
  const eventType = typeof event.event_type === "string" ? event.event_type : null;
  const resource = isRecord(event.resource) ? event.resource : null;
  const invoice = resource && isRecord(resource.invoice) ? resource.invoice : resource;
  let invoiceId = invoice && typeof invoice.id === "string" && invoice.id.startsWith("INV") ? invoice.id : null;
  const status = invoice && typeof invoice.status === "string" ? invoice.status : null;
  if (!invoiceId) {
    const match = JSON.stringify(event).match(/INV2-[A-Z0-9-]+/);
    invoiceId = match?.[0] ?? null;
  }
  return { eventType, invoiceId, status };
}

export function extractPayoutBatch(event: unknown): { batchId: string; status: string } | null {
  if (!isRecord(event) || !isRecord(event.resource)) return null;
  const resource = event.resource;
  const header = isRecord(resource.batch_header) ? resource.batch_header : null;
  const batchId =
    (header && typeof header.payout_batch_id === "string" && header.payout_batch_id) ||
    (typeof resource.payout_batch_id === "string" && resource.payout_batch_id) ||
    null;
  const status =
    (header && typeof header.batch_status === "string" && header.batch_status) ||
    (typeof resource.transaction_status === "string" && resource.transaction_status) ||
    (typeof resource.status === "string" && resource.status) ||
    null;
  if (!batchId || !status) return null;
  return { batchId, status };
}

export function extractBatchId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.batch_header) && typeof body.batch_header.payout_batch_id === "string") {
    return body.batch_header.payout_batch_id;
  }
  if (typeof body.payout_batch_id === "string") return body.payout_batch_id;
  const match = JSON.stringify(body).match(/\/payouts\/([A-Za-z0-9-]+)/);
  return match?.[1] ?? null;
}

export function findShareUrl(body: unknown): string | null {
  const urls: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string" && /^https?:\/\//.test(node)) urls.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (isRecord(node)) Object.values(node).forEach(walk);
  };
  walk(body);
  const usable = urls.filter((url) => !/api(-m)?\.(sandbox\.)?paypal\.com/i.test(url));
  return (
    usable.find((url) => /paypal\.com/i.test(url) && /invoice|payer/i.test(url)) ||
    usable.find((url) => /paypal\.com/i.test(url)) ||
    null
  );
}

export function extractInvoiceId(body: unknown): string | null {
  if (isRecord(body) && typeof body.id === "string" && body.id.startsWith("INV")) return body.id;
  const match = JSON.stringify(body ?? {}).match(/INV2-[A-Z0-9-]+/);
  return match?.[0] ?? null;
}
