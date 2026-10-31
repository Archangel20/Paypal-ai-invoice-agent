import { paypalBaseUrl, paypalConfigured, paypalCredentials } from "./config";
import { extractBatchId } from "./events";
import { isRecord } from "./validators";

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

export class PayPalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalConfigError";
  }
}

type Token = { value: string; expiresAt: number };
let token: Token | null = null;

export function clearTokenCache() {
  token = null;
}

export async function getAccessToken(): Promise<string> {
  if (!paypalConfigured()) {
    throw new PayPalConfigError(
      "PayPal sandbox credentials are not set. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env.local and restart.",
    );
  }
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const { clientId, clientSecret } = paypalCredentials();
  const response = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const body = await readJson(response);
  if (!response.ok || !isRecord(body) || typeof body.access_token !== "string") {
    throw new PayPalError(formatPayPalBody(body, response.status), response.status, body);
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 300;
  token = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return token.value;
}

export async function paypalRequest(path: string, init?: { method?: string; body?: unknown; requestId?: string }): Promise<unknown> {
  const accessToken = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  if (init?.requestId) headers["PayPal-Request-Id"] = init.requestId;
  const response = await fetch(`${paypalBaseUrl()}${path}`, {
    method: init?.method || "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new PayPalError(formatPayPalBody(body, response.status), response.status, body);
  }
  return body;
}

export function formatPayPalBody(body: unknown, status: number): string {
  if (!isRecord(body)) return `PayPal request failed (${status}).`;
  const message =
    (typeof body.message === "string" && body.message) ||
    (typeof body.error_description === "string" && body.error_description) ||
    (typeof body.name === "string" && body.name) ||
    `PayPal request failed (${status}).`;
  const details = Array.isArray(body.details)
    ? body.details
        .map((detail) => (isRecord(detail) ? detail.description || detail.issue : ""))
        .filter((detail): detail is string => typeof detail === "string" && detail.length > 0)
        .join("; ")
    : "";
  const debug = typeof body.debug_id === "string" ? ` (debug_id ${body.debug_id})` : "";
  return `${message}${details ? `: ${details}` : ""}${debug}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

export type PayoutItem = {
  receiver: string;
  amount: string;
  note: string;
  senderItemId: string;
};

export type PayoutRequest = {
  senderBatchId: string;
  currency: string;
  subject: string;
  items: PayoutItem[];
};

export type PayoutResult = {
  payoutBatchId: string | null;
  status: string;
  raw: unknown;
};

export async function createPayoutBatch(request: PayoutRequest): Promise<PayoutResult> {
  const body = {
    sender_batch_header: {
      sender_batch_id: request.senderBatchId,
      email_subject: request.subject.slice(0, 255),
      email_message: "A client paid an invoice in Splitnote. This is your collaborator share.",
    },
    items: request.items.map((item) => ({
      recipient_type: "EMAIL",
      receiver: item.receiver,
      note: item.note.slice(0, 400),
      sender_item_id: item.senderItemId,
      amount: { value: item.amount, currency: request.currency },
    })),
  };
  try {
    const data = await paypalRequest("/v1/payments/payouts", {
      method: "POST",
      body,
      requestId: request.senderBatchId,
    });
    return readPayoutResult(data);
  } catch (error) {
    if (error instanceof PayPalError && /duplicate|sender_batch_id/i.test(error.message)) {
      const payoutBatchId = extractBatchId(error.body);
      if (payoutBatchId) return { payoutBatchId, status: "PENDING", raw: error.body };
    }
    throw error;
  }
}

function readPayoutResult(data: unknown): PayoutResult {
  const payoutBatchId = extractBatchId(data);
  let status = "PENDING";
  if (isRecord(data) && isRecord(data.batch_header) && typeof data.batch_header.batch_status === "string") {
    status = data.batch_header.batch_status;
  }
  if (!payoutBatchId) throw new Error("PayPal accepted the payout call but didn't return a batch id.");
  return { payoutBatchId, status, raw: data };
}

export function isPayPalCertUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

export async function verifyWebhookSignature(
  headers: Headers,
  event: unknown,
): Promise<{ verified: boolean; reason?: string }> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim();
  if (!webhookId) {
    return { verified: false, reason: "Set PAYPAL_WEBHOOK_ID to the webhook id from your PayPal app." };
  }
  const transmissionId = headers.get("paypal-transmission-id") || "";
  const transmissionTime = headers.get("paypal-transmission-time") || "";
  const transmissionSig = headers.get("paypal-transmission-sig") || "";
  const certUrl = headers.get("paypal-cert-url") || "";
  const authAlgo = headers.get("paypal-auth-algo") || "";
  if (!transmissionId || !transmissionTime || !transmissionSig || !authAlgo) {
    return { verified: false, reason: "Missing PayPal transmission headers." };
  }
  if (!isPayPalCertUrl(certUrl)) {
    return { verified: false, reason: "Certificate URL is not an https PayPal host." };
  }
  try {
    const result = await paypalRequest("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
    const status = isRecord(result) && typeof result.verification_status === "string" ? result.verification_status : "";
    if (status === "SUCCESS") return { verified: true };
    return { verified: false, reason: `PayPal verification_status was ${status || "missing"}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook verification failed.";
    return { verified: false, reason: message };
  }
}
