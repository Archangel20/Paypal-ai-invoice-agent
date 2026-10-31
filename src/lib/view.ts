import {
  demoModeEnabled,
  llmConfigured,
  llmProviderLabel,
  modelName,
  paypalConfigured,
  paypalEnvLabel,
} from "./config";
import {
  collectedCents,
  latestConversationId,
  listActivity,
  listInvoices,
  listMessages,
  listPayouts,
  outstandingCents,
  paidOutCents,
  resolveDatabasePath,
  type DB,
} from "./db";
import { toolkitInstalled } from "./toolkit";
import { currentMonth } from "./time";
import type { StudioSnapshot } from "./types";

export async function snapshot(db: DB, conversationId?: string): Promise<StudioSnapshot> {
  const id = conversationId || latestConversationId(db);
  const month = currentMonth();
  const invoices = listInvoices(db);
  const database = resolveDatabasePath();
  return {
    conversationId: id,
    messages: listMessages(db, id),
    invoices,
    payouts: listPayouts(db),
    activity: listActivity(db),
    summary: {
      outstandingCents: outstandingCents(db),
      collectedThisMonthCents: collectedCents(db, month),
      paidOutThisMonthCents: paidOutCents(db, month),
      currency: invoices[0]?.currency || "USD",
      month,
    },
    health: {
      paypalConfigured: paypalConfigured(),
      llmConfigured: llmConfigured(),
      model: modelName(),
      provider: llmProviderLabel(),
      demoMode: demoModeEnabled(),
      paypalEnv: paypalEnvLabel(),
      toolkitInstalled: await toolkitInstalled(),
      databasePath: database.file,
      databaseEphemeral: database.ephemeral,
    },
  };
}
