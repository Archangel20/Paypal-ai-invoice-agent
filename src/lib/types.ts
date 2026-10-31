export type StepTone = "neutral" | "wait" | "good" | "bad";

export type ChatStep = {
  title: string;
  body: string;
  tone: StepTone;
  via?: string;
};

export type ToolPayload = {
  ok: boolean;
  summary: string;
  steps: ChatStep[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps: ChatStep[];
  engine: string | null;
  createdAt: string;
};

export type SplitView = {
  email: string;
  label: string | null;
  percent: number;
  amountCents: number;
  status: string;
};

export type InvoiceView = {
  id: string;
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
  error: string | null;
  createdAt: string;
  paidAt: string | null;
  splits: SplitView[];
};

export type PayoutView = {
  id: string;
  invoiceId: string;
  paypalBatchId: string | null;
  senderBatchId: string;
  recipientEmail: string;
  amountCents: number;
  currency: string;
  status: string;
  note: string | null;
  error: string | null;
  createdAt: string;
};

export type ActivityView = {
  id: string;
  eventType: string;
  source: string;
  verified: boolean;
  summary: string;
  createdAt: string;
};

export type Summary = {
  outstandingCents: number;
  collectedThisMonthCents: number;
  paidOutThisMonthCents: number;
  currency: string;
  month: string;
};

export type Health = {
  paypalConfigured: boolean;
  llmConfigured: boolean;
  model: string;
  provider: string;
  demoMode: boolean;
  paypalEnv: string;
  toolkitInstalled: boolean;
  databasePath: string;
  databaseEphemeral: boolean;
};

export type StudioSnapshot = {
  conversationId: string;
  messages: ChatMessage[];
  invoices: InvoiceView[];
  payouts: PayoutView[];
  activity: ActivityView[];
  summary: Summary;
  health: Health;
};
