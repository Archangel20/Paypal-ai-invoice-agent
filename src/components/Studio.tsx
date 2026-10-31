"use client";

import { EXAMPLE_PROMPTS } from "@/lib/examples";
import { formatMoney } from "@/lib/money";
import { termLabel } from "@/lib/terms";
import { formatDay, formatWhen } from "@/lib/time";
import type { ChatMessage, InvoiceView, StudioSnapshot } from "@/lib/types";
import { useEffect, useRef, useState } from "react";

type Payload = StudioSnapshot & { notice?: string };

export function Studio() {
  const [data, setData] = useState<Payload | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [data?.messages.length, pending]);

  async function load() {
    try {
      const response = await fetch("/api/dashboard");
      const body = (await response.json()) as Payload & { error?: string };
      if (!response.ok) {
        setError(body.error || "Could not load the ledger.");
        return;
      }
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the ledger.");
    }
  }

  async function send(text = draft) {
    const message = text.trim();
    if (!message || pending) return;
    setPending(true);
    setError(null);
    setDraft("");
    try {
      const body = await postJson("/api/chat", { message, conversationId: data?.conversationId });
      setData(body);
    } catch (err) {
      setDraft(message);
      setError(err instanceof Error ? err.message : "The request failed.");
    } finally {
      setPending(false);
    }
  }

  async function simulate(invoiceId: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const body = await postJson("/api/demo/invoice-paid", { invoiceId, conversationId: data?.conversationId });
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not simulate payment.");
    } finally {
      setPending(false);
    }
  }

  async function sync() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const body = await postJson("/api/sync", { conversationId: data?.conversationId });
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setPending(false);
    }
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-6xl px-5 py-16 text-muted">
        {error ? error : "Opening the ledger…"}
      </main>
    );
  }

  const health = data.health;

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-10">
      <a href="#instruction" className="sr-only">
        Skip to the instruction box
      </a>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-gold">PayPal sandbox</p>
          <h1 className="font-display text-4xl text-ink md:text-5xl">Splitnote</h1>
          <p className="mt-2 max-w-xl text-muted">
            Bill a client in a sentence. When they pay, collaborators get their split.
          </p>
        </div>
        <div className="text-sm text-muted">
          <div>{health.paypalEnv === "live" ? "Live PayPal" : "Sandbox"} · {health.paypalConfigured ? "credentials set" : "credentials missing"}</div>
          <div>
            Agent: {health.llmConfigured ? health.model : "local parser"}
            {health.toolkitInstalled ? " · toolkit installed" : ""}
          </div>
        </div>
      </header>

      {!health.paypalConfigured && (
        <p data-testid="setup-banner" className="mb-6 rounded-2xl border border-line bg-card px-4 py-3 text-sm" role="status">
          Add <code>PAYPAL_CLIENT_ID</code> and <code>PAYPAL_CLIENT_SECRET</code> to <code>.env.local</code>, then restart.
          The ledger stays empty until an invoice is really created.
        </p>
      )}
      {health.databaseEphemeral && (
        <p className="mb-6 rounded-2xl border border-line bg-card px-4 py-3 text-sm text-muted" role="status">
          The database is ephemeral ({health.databasePath}). Invoices disappear when this machine restarts.
        </p>
      )}
      {(error || data.notice) && (
        <p className="mb-6 rounded-2xl border border-line bg-card px-4 py-3 text-sm" role="status">
          {error || data.notice}
        </p>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
        <section className="flex min-h-[70vh] flex-col rounded-3xl border border-line bg-card/90 shadow-[0_24px_60px_rgba(60,40,20,0.06)]">
          <div ref={threadRef} data-testid="thread" className="flex-1 space-y-4 overflow-y-auto px-4 py-5 md:px-6" aria-live="polite">
            {data.messages.length === 0 && (
              <div className="rounded-2xl border border-dashed border-line px-4 py-8">
                <p className="font-display text-2xl">Start with a sentence.</p>
                <p className="mt-2 max-w-md text-sm text-muted">
                  Name the client, the amount, the work, the terms, and who should be paid when the invoice clears.
                </p>
              </div>
            )}
            {data.messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {pending && <p className="text-sm text-muted">Talking to PayPal…</p>}
          </div>
          <form
            className="sticky bottom-0 border-t border-line bg-card px-4 py-4 md:px-6"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="mb-3 flex flex-wrap gap-2">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt.label}
                  type="button"
                  className="rounded-full border border-line px-3 py-1 text-xs text-navy hover:bg-paper"
                  onClick={() => setDraft(prompt.text)}
                >
                  {prompt.label}
                </button>
              ))}
            </div>
            <label htmlFor="instruction" className="sr-only">
              Instruction
            </label>
            <textarea
              id="instruction"
              data-testid="composer"
              value={draft}
              rows={3}
              placeholder="Bill Acme (acme@example.com) $1,200 for the October logo work…"
              className="w-full resize-none rounded-2xl border border-line bg-paper px-3 py-3 text-sm"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-muted">Enter to send. Shift+Enter for a new line.</p>
              <button
                data-testid="send"
                type="submit"
                disabled={pending || !draft.trim()}
                className="rounded-full bg-ink px-4 py-2 text-sm text-paper disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </form>
        </section>

        <aside className="space-y-4">
          <section className="grid grid-cols-3 gap-2">
            <Stat label="Outstanding" value={formatMoney(data.summary.outstandingCents, data.summary.currency)} testId="outstanding" />
            <Stat label="Collected" value={formatMoney(data.summary.collectedThisMonthCents, data.summary.currency)} hint={data.summary.month} />
            <Stat label="Paid out" value={formatMoney(data.summary.paidOutThisMonthCents, data.summary.currency)} hint={data.summary.month} />
          </section>

          <section className="rounded-3xl border border-line bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="font-display text-2xl">Invoices</h2>
              <button
                type="button"
                data-testid="sync"
                onClick={() => void sync()}
                disabled={pending || !health.paypalConfigured}
                className="rounded-full border border-line px-3 py-1 text-xs disabled:opacity-40"
              >
                Refresh PayPal
              </button>
            </div>
            {data.invoices.length === 0 ? (
              <p className="text-sm text-muted">No invoices yet. The ledger fills in when you send the first one.</p>
            ) : (
              <ul className="space-y-3">
                {data.invoices.map((invoice) => (
                  <li key={invoice.id}>
                    <InvoiceCard
                      invoice={invoice}
                      demoMode={health.demoMode}
                      pending={pending}
                      onSimulate={() => void simulate(invoice.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-3xl border border-line bg-card p-4">
            <h2 className="font-display text-2xl">Payouts</h2>
            {data.payouts.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Collaborator payouts show up here after an invoice is paid.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {data.payouts.map((payout) => (
                  <li key={payout.id} className="border-t border-line pt-3 text-sm first:border-0 first:pt-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <span>{payout.recipientEmail}</span>
                      <span className="font-display text-lg tabular-nums">{formatMoney(payout.amountCents, payout.currency)}</span>
                    </div>
                    <p className="text-xs text-muted">
                      {payout.status} · {payout.paypalBatchId || "no batch id"} · {formatWhen(payout.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.activity.length > 0 && (
            <section className="rounded-3xl border border-line bg-card p-4">
              <h2 className="font-display text-2xl">Activity</h2>
              <ul className="mt-3 space-y-3">
                {data.activity.map((item) => (
                  <li key={item.id} className="text-sm">
                    <p className="text-xs uppercase tracking-wide text-muted">
                      {item.source} · {item.verified ? "verified" : "unverified"} · {formatWhen(item.createdAt)}
                    </p>
                    <p>{item.summary}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="px-1 text-xs leading-5 text-muted">
            No login. Demo mode can trigger a real sandbox payout. Set <code>DEMO_MODE=false</code> before a public deploy.
            Real payments should hit <code>/api/webhooks/paypal</code>.
          </p>
        </aside>
      </div>
    </main>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const mine = message.role === "user";
  return (
    <article className={mine ? "ml-8" : "mr-6"}>
      <div className={mine ? "rounded-3xl rounded-br-md bg-ink px-4 py-3 text-paper" : "rounded-3xl rounded-bl-md border border-line bg-paper px-4 py-3"}>
        {!mine && (
          <p className="mb-1 text-[11px] uppercase tracking-[0.16em] text-muted">
            Splitnote{message.engine ? ` · ${engineLabel(message.engine)}` : ""}
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>
        {message.steps.length > 0 && (
          <ol className="mt-4 space-y-3 border-l border-line pl-4">
            {message.steps.map((step, index) => (
              <li key={`${step.title}-${index}`} className="relative">
                <span className="step-dot absolute -left-[1.28rem]" data-tone={step.tone} />
                <p className="text-sm font-medium">{step.title}</p>
                <p className="text-sm text-muted">{step.body}</p>
                {step.via && <p className="mt-1 font-mono text-[11px] text-muted">{step.via}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
      <p className={`mt-1 text-[11px] text-muted ${mine ? "text-right" : ""}`}>{formatWhen(message.createdAt)}</p>
    </article>
  );
}

function InvoiceCard({
  invoice,
  demoMode,
  pending,
  onSimulate,
}: {
  invoice: InvoiceView;
  demoMode: boolean;
  pending: boolean;
  onSimulate: () => void;
}) {
  const canSimulate = demoMode && (invoice.status === "sent" || invoice.status === "payout_failed");
  return (
    <article className="rounded-2xl border border-line bg-paper/70 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-xl leading-none">{invoice.clientName}</h3>
          <p className="mt-1 text-xs text-muted">{invoice.clientEmail}</p>
        </div>
        <div className="text-right">
          <p className="font-display text-2xl tabular-nums leading-none">{formatMoney(invoice.amountCents, invoice.currency)}</p>
          <p className="mt-1 text-[11px] uppercase tracking-wide text-navy">{invoiceStatusLabel(invoice.status)}</p>
        </div>
      </div>
      <p className="mt-3 text-sm">{invoice.description}</p>
      <p className="text-sm text-muted">
        {termLabel(invoice.paymentTerm)} · due {formatDay(invoice.dueDate)}
        {invoice.paypalStatus ? ` · PayPal ${invoice.paypalStatus}` : ""}
      </p>
      {invoice.splits.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {invoice.splits.map((split) => (
            <li key={split.email} className="flex justify-between gap-3 text-muted">
              <span>{split.label ? `${split.label} · ` : ""}{split.email}</span>
              <span className="tabular-nums text-ink">{split.percent}% · {formatMoney(split.amountCents, invoice.currency)}</span>
            </li>
          ))}
        </ul>
      )}
      {invoice.error && <p className="mt-2 text-sm text-clay">{invoice.error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {invoice.shareUrl && (
          <a className="rounded-full border border-line px-3 py-1 text-xs" href={invoice.shareUrl} target="_blank" rel="noreferrer">
            Open invoice
          </a>
        )}
        {canSimulate && (
          <button
            type="button"
            data-testid="simulate-payment"
            disabled={pending}
            onClick={onSimulate}
            className="rounded-full bg-navy px-3 py-1 text-xs text-paper disabled:opacity-40"
          >
            {invoice.status === "payout_failed" ? "Retry payout" : "Simulate payment"}
          </button>
        )}
      </div>
      <details className="mt-3 text-xs text-muted">
        <summary>PayPal path</summary>
        <p className="mt-1 font-mono">{invoice.paypalInvoiceId}</p>
        <p className="mt-1 font-mono">{invoice.via}</p>
      </details>
    </article>
  );
}

function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-3 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p data-testid={testId} className="font-display text-xl tabular-nums leading-tight">{value}</p>
      {hint && <p className="text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

function invoiceStatusLabel(status: string): string {
  switch (status) {
    case "sent":
      return "Awaiting payment";
    case "paid":
      return "Paid";
    case "settled":
      return "Split sent";
    case "payout_failed":
      return "Payout failed";
    default:
      return status;
  }
}

function engineLabel(engine: string): string {
  if (engine.startsWith("local-parser")) return "Local parser";
  if (engine === "demo") return "Demo mode";
  if (engine === "paypal-webhook") return "Webhook";
  if (engine === "paypal-sync") return "PayPal sync";
  return engine;
}

async function postJson(url: string, body: unknown): Promise<Payload> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Payload & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}
