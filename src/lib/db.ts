import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { ActivityView, ChatMessage, ChatStep, InvoiceView, PayoutView, SplitView } from "./types";
import type { SplitLine } from "./money";
import { nowIso } from "./time";

export type DB = Database.Database;

type InvoiceSql = {
  id: string;
  paypal_invoice_id: string;
  client_name: string;
  client_email: string;
  description: string;
  amount_cents: number;
  currency: string;
  payment_term: string;
  due_date: string;
  status: string;
  paypal_status: string | null;
  share_url: string | null;
  via: string;
  error: string | null;
  created_at: string;
  paid_at: string | null;
};

type SplitSql = {
  id: string;
  invoice_id: string;
  recipient_email: string;
  recipient_label: string | null;
  percent: number;
  amount_cents: number;
  status: string;
};

type PayoutSql = {
  id: string;
  invoice_id: string;
  paypal_batch_id: string | null;
  sender_batch_id: string;
  recipient_email: string;
  amount_cents: number;
  currency: string;
  status: string;
  note: string | null;
  error: string | null;
  created_at: string;
};

type MessageSql = {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps_json: string;
  engine: string | null;
  created_at: string;
};

let singleton: DB | null = null;

export function resolveDatabasePath(): { file: string; ephemeral: boolean } {
  if (process.env.DATABASE_PATH === ":memory:") return { file: ":memory:", ephemeral: true };
  const configured = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "splitnote.db");
  try {
    fs.mkdirSync(path.dirname(configured), { recursive: true });
    fs.accessSync(path.dirname(configured), fs.constants.W_OK);
    return { file: configured, ephemeral: configured.startsWith("/tmp/") };
  } catch {
    return { file: path.join("/tmp", "splitnote.db"), ephemeral: true };
  }
}

export function openDatabase(file = resolveDatabasePath().file): DB {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma(file === ":memory:" ? "journal_mode = MEMORY" : "journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function getDb(): DB {
  if (!singleton) singleton = openDatabase();
  return singleton;
}

function migrate(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      steps_json TEXT NOT NULL DEFAULT '[]',
      engine TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      paypal_invoice_id TEXT NOT NULL UNIQUE,
      client_name TEXT NOT NULL,
      client_email TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      payment_term TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL,
      paypal_status TEXT,
      share_url TEXT,
      via TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      paid_at TEXT
    );
    CREATE TABLE IF NOT EXISTS splits (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      recipient_label TEXT,
      percent REAL NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );
    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      paypal_batch_id TEXT,
      sender_batch_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      error TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      invoice_id TEXT,
      source TEXT NOT NULL,
      verified INTEGER NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export function latestConversationId(db: DB): string {
  const row = db.prepare("SELECT id FROM conversations ORDER BY created_at DESC LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (row) return row.id;
  return ensureConversation(db);
}

export function ensureConversation(db: DB, id?: string): string {
  if (id) {
    const existing = db.prepare("SELECT id FROM conversations WHERE id = ?").get(id) as { id: string } | undefined;
    if (existing) return existing.id;
  }
  const created = id || crypto.randomUUID();
  db.prepare("INSERT INTO conversations (id, created_at) VALUES (?, ?)").run(created, nowIso());
  return created;
}

export function addMessage(
  db: DB,
  input: { conversationId: string; role: "user" | "assistant"; content: string; steps: ChatStep[]; engine: string | null },
): ChatMessage {
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: input.role,
    content: input.content,
    steps: input.steps,
    engine: input.engine,
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, steps_json, engine, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(message.id, input.conversationId, message.role, message.content, JSON.stringify(message.steps), message.engine, message.createdAt);
  return message;
}

export function listMessages(db: DB, conversationId: string): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT role, content, steps_json, engine, created_at, id
       FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200`,
    )
    .all(conversationId) as MessageSql[];
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    steps: parseSteps(row.steps_json),
    engine: row.engine,
    createdAt: row.created_at,
  }));
}

function parseSteps(value: string): ChatStep[] {
  try {
    const parsed = JSON.parse(value) as ChatStep[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type NewInvoice = {
  paypalInvoiceId: string;
  clientName: string;
  clientEmail: string;
  description: string;
  amountCents: number;
  currency: string;
  paymentTerm: string;
  dueDate: string;
  status: string;
  paypalStatus: string | null;
  shareUrl: string | null;
  via: string;
};

export function insertInvoice(db: DB, invoice: NewInvoice, splits: SplitLine[]): InvoiceView {
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO invoices (
        id, paypal_invoice_id, client_name, client_email, description, amount_cents, currency,
        payment_term, due_date, status, paypal_status, share_url, via, error, created_at, paid_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    ).run(
      id,
      invoice.paypalInvoiceId,
      invoice.clientName,
      invoice.clientEmail,
      invoice.description,
      invoice.amountCents,
      invoice.currency,
      invoice.paymentTerm,
      invoice.dueDate,
      invoice.status,
      invoice.paypalStatus,
      invoice.shareUrl,
      invoice.via,
      createdAt,
    );
    const splitStmt = db.prepare(
      `INSERT INTO splits (id, invoice_id, recipient_email, recipient_label, percent, amount_cents, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    );
    for (const split of splits) {
      splitStmt.run(crypto.randomUUID(), id, split.email, split.label, split.percent, split.amountCents);
    }
  });
  write();
  const saved = getInvoice(db, id);
  if (!saved) throw new Error("Invoice was saved but could not be read back.");
  return saved;
}

export function getInvoice(db: DB, id: string): InvoiceView | null {
  const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceSql | undefined;
  if (!row) return null;
  const splits = db.prepare("SELECT * FROM splits WHERE invoice_id = ?").all(id) as SplitSql[];
  return mapInvoice(row, splits.map(mapSplit));
}

export function findInvoiceByPaypalId(db: DB, paypalInvoiceId: string): InvoiceView | null {
  const row = db.prepare("SELECT * FROM invoices WHERE paypal_invoice_id = ?").get(paypalInvoiceId) as InvoiceSql | undefined;
  if (!row) return null;
  const splits = db.prepare("SELECT * FROM splits WHERE invoice_id = ?").all(row.id) as SplitSql[];
  return mapInvoice(row, splits.map(mapSplit));
}

export function listInvoices(db: DB): InvoiceView[] {
  const rows = db.prepare("SELECT * FROM invoices ORDER BY created_at DESC").all() as InvoiceSql[];
  const splits = db.prepare("SELECT * FROM splits").all() as SplitSql[];
  const grouped = new Map<string, SplitView[]>();
  for (const split of splits) {
    const list = grouped.get(split.invoice_id) || [];
    list.push(mapSplit(split));
    grouped.set(split.invoice_id, list);
  }
  return rows.map((row) => mapInvoice(row, grouped.get(row.id) || []));
}

export function setPaypalStatus(db: DB, id: string, status: string, shareUrl?: string | null) {
  if (shareUrl) {
    db.prepare("UPDATE invoices SET paypal_status = ?, share_url = COALESCE(share_url, ?) WHERE id = ?").run(status, shareUrl, id);
  } else {
    db.prepare("UPDATE invoices SET paypal_status = ? WHERE id = ?").run(status, id);
  }
}

export function markInvoicePaid(db: DB, id: string, paypalStatus: string | null) {
  db.prepare(
    `UPDATE invoices
     SET status = 'paid', paid_at = COALESCE(paid_at, ?), paypal_status = COALESCE(?, paypal_status)
     WHERE id = ?`,
  ).run(nowIso(), paypalStatus, id);
}

export function markInvoiceSettled(db: DB, id: string) {
  db.prepare(
    `UPDATE invoices SET status = 'settled', error = NULL, paid_at = COALESCE(paid_at, ?) WHERE id = ?`,
  ).run(nowIso(), id);
}

export function markInvoicePayoutFailed(db: DB, id: string, error: string) {
  db.prepare(
    `UPDATE invoices SET status = 'payout_failed', error = ?, paid_at = COALESCE(paid_at, ?) WHERE id = ?`,
  ).run(error, nowIso(), id);
}

export function setSplitStatus(db: DB, invoiceId: string, status: string) {
  db.prepare("UPDATE splits SET status = ? WHERE invoice_id = ?").run(status, invoiceId);
}

export function listPayoutsForInvoice(db: DB, invoiceId: string): PayoutView[] {
  const rows = db.prepare("SELECT * FROM payouts WHERE invoice_id = ? ORDER BY created_at ASC").all(invoiceId) as PayoutSql[];
  return rows.map(mapPayout);
}

export function listPayouts(db: DB): PayoutView[] {
  const rows = db.prepare("SELECT * FROM payouts ORDER BY created_at DESC LIMIT 50").all() as PayoutSql[];
  return rows.map(mapPayout);
}

export function insertPayout(
  db: DB,
  input: {
    invoiceId: string;
    paypalBatchId: string | null;
    senderBatchId: string;
    recipientEmail: string;
    amountCents: number;
    currency: string;
    status: string;
    note: string;
    raw: unknown;
  },
) {
  db.prepare(
    `INSERT INTO payouts (
      id, invoice_id, paypal_batch_id, sender_batch_id, recipient_email, amount_cents,
      currency, status, note, error, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    input.invoiceId,
    input.paypalBatchId,
    input.senderBatchId,
    input.recipientEmail,
    input.amountCents,
    input.currency,
    input.status,
    input.note,
    JSON.stringify(input.raw ?? null),
    nowIso(),
  );
}

export function updatePayoutsByBatch(db: DB, batchId: string, status: string) {
  const result = db.prepare("UPDATE payouts SET status = ? WHERE paypal_batch_id = ?").run(status, batchId);
  return result.changes;
}

export function insertEvent(
  db: DB,
  input: { id: string; eventType: string; invoiceId: string | null; source: string; verified: boolean; summary: string; payload: unknown },
): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO events (id, event_type, invoice_id, source, verified, summary, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.eventType,
    input.invoiceId,
    input.source,
    input.verified ? 1 : 0,
    input.summary,
    JSON.stringify(input.payload ?? null),
    nowIso(),
  );
  return result.changes > 0;
}

export function listActivity(db: DB): ActivityView[] {
  const rows = db
    .prepare(
      `SELECT id, event_type, source, verified, summary, created_at
       FROM events ORDER BY created_at DESC LIMIT 12`,
    )
    .all() as Array<{
    id: string;
    event_type: string;
    source: string;
    verified: number;
    summary: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    source: row.source,
    verified: row.verified === 1,
    summary: row.summary,
    createdAt: row.created_at,
  }));
}

export function outstandingCents(db: DB): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM invoices WHERE status = 'sent'").get() as { n: number };
  return row.n;
}

export function collectedCents(db: DB, month: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM invoices
       WHERE paid_at LIKE ? AND status IN ('paid', 'settled', 'payout_failed')`,
    )
    .get(`${month}%`) as { n: number };
  return row.n;
}

export function paidOutCents(db: DB, month: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payouts
       WHERE created_at LIKE ? AND UPPER(status) NOT IN ('FAILED', 'DENIED', 'CANCELED', 'CANCELLED', 'RETURNED', 'BLOCKED')`,
    )
    .get(`${month}%`) as { n: number };
  return row.n;
}

function mapSplit(row: SplitSql): SplitView {
  return {
    email: row.recipient_email,
    label: row.recipient_label,
    percent: row.percent,
    amountCents: row.amount_cents,
    status: row.status,
  };
}

function mapInvoice(row: InvoiceSql, splits: SplitView[]): InvoiceView {
  return {
    id: row.id,
    paypalInvoiceId: row.paypal_invoice_id,
    clientName: row.client_name,
    clientEmail: row.client_email,
    description: row.description,
    amountCents: row.amount_cents,
    currency: row.currency,
    paymentTerm: row.payment_term,
    dueDate: row.due_date,
    status: row.status,
    paypalStatus: row.paypal_status,
    shareUrl: row.share_url,
    via: row.via,
    error: row.error,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    splits,
  };
}

function mapPayout(row: PayoutSql): PayoutView {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    paypalBatchId: row.paypal_batch_id,
    senderBatchId: row.sender_batch_id,
    recipientEmail: row.recipient_email,
    amountCents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    note: row.note,
    error: row.error,
    createdAt: row.created_at,
  };
}
