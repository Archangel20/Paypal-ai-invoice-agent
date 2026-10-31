import { generateText, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { billClient, monthlyIncome, runParsed, toolForCommand, whoOwes, type BillInput } from "./actions";
import { llmConfigured, modelName } from "./config";
import { addMessage, ensureConversation, latestConversationId, listMessages, type DB } from "./db";
import { parseInstruction } from "./parseInstruction";
import { PAYMENT_TERMS } from "./terms";
import { todayUtc } from "./time";
import type { ChatStep, ToolPayload } from "./types";
import { snapshot } from "./view";

const billSchema = z.object({
  clientName: z.string().describe("Client or company to bill"),
  clientEmail: z.string().describe("Client email address"),
  amount: z.number().positive().describe("Invoice total in major units, such as 1200 for $1,200"),
  currency: z.enum(["USD", "EUR", "GBP"]).optional().describe("ISO currency. Defaults to USD."),
  description: z.string().describe("What the invoice is for, in a short phrase"),
  paymentTerm: z.enum(PAYMENT_TERMS).optional().describe("Defaults to DUE_ON_RECEIPT. Use NET_15 for net-15."),
  collaborators: z
    .array(
      z.object({
        email: z.string().describe("Collaborator PayPal email"),
        label: z.string().optional().describe("Role, such as designer"),
        percent: z.number().positive().max(100).describe("Percent of the invoice, such as 30 for 30%"),
      }),
    )
    .optional()
    .describe("Shares to pay only after the client pays. Omit if there is no split."),
});

export async function handleUserMessage(db: DB, conversationId: string | undefined, message: string) {
  const text = message.trim();
  if (!text || text.length > 2000) {
    throw new Error("Write an instruction under 2,000 characters.");
  }
  const convo = conversationId ? ensureConversation(db, conversationId) : latestConversationId(db);
  addMessage(db, { conversationId: convo, role: "user", content: text, steps: [], engine: null });
  const reply = await respond(db, convo, text);
  addMessage(db, { conversationId: convo, role: "assistant", content: reply.content, steps: reply.steps, engine: reply.engine });
  return snapshot(db, convo);
}

async function respond(db: DB, conversationId: string, message: string): Promise<{ content: string; steps: ChatStep[]; engine: string }> {
  const parsed = parseInstruction(message);
  if (!llmConfigured()) {
    if (!parsed) {
      return {
        content:
          "I can bill a client, check who still owes you, or total a month's income. Try one of the examples. Add OPENAI_API_KEY to handle freer wording with a model.",
        steps: [],
        engine: "local-parser",
      };
    }
    const payload = await runParsed(db, parsed);
    return { content: payload.summary, steps: payload.steps, engine: "local-parser" };
  }

  try {
    const history = listMessages(db, conversationId)
      .slice(-12)
      .map((entry) => ({ role: entry.role, content: entry.content }));
    const result = await generateText({
      model: languageModel(),
      system: systemPrompt(),
      messages: history,
      tools: {
        bill_client: tool({
          description:
            "Create and send a PayPal invoice, then store collaborator splits that pay out only after the invoice is paid.",
          parameters: billSchema,
          execute: async (input) => billClient(db, input as BillInput),
        }),
        who_owes_me: tool({
          description: "List open invoices that have been sent and not yet paid.",
          parameters: z.object({
            email: z.string().optional().describe("Optional client email filter"),
          }),
          execute: async ({ email }) => whoOwes(db, email),
        }),
        monthly_income: tool({
          description: "Sum client payments collected in a month, plus collaborator payouts.",
          parameters: z.object({
            month: z.string().optional().describe("YYYY-MM. Omit for the current UTC month."),
          }),
          execute: async ({ month }) => monthlyIncome(db, month),
        }),
      },
      maxSteps: 4,
      temperature: 0.2,
    });

    const seen = new Set<string>();
    const called = new Set<string>();
    const steps: ChatStep[] = [];
    let summary = "";
    for (const step of result.steps) {
      for (const toolResult of step.toolResults) {
        if (seen.has(toolResult.toolCallId)) continue;
        seen.add(toolResult.toolCallId);
        called.add(toolResult.toolName);
        const payload = toolResult.result as ToolPayload;
        if (payload?.steps) steps.push(...payload.steps);
        if (payload?.summary) summary = payload.summary;
      }
    }

    const expected = toolForCommand(parsed);
    if (expected && !called.has(expected) && parsed && parsed.kind !== "clarify") {
      const payload = await runParsed(db, parsed);
      return {
        content: payload.summary,
        steps: payload.steps,
        engine: `${modelName()}+parser`,
      };
    }

    const content = result.text.trim() || summary || "I didn't have anything to add.";
    return { content, steps, engine: modelName() };
  } catch (error) {
    if (parsed && parsed.kind !== "clarify") {
      const payload = await runParsed(db, parsed);
      return {
        content: `The model didn't respond (${error instanceof Error ? error.message : "request failed"}), so I used the built-in parser. ${payload.summary}`,
        steps: payload.steps,
        engine: "local-parser-fallback",
      };
    }
    const message = error instanceof Error ? error.message : "The model request failed.";
    return {
      content: message,
      steps: [{ tone: "bad", title: "Model request failed", body: message }],
      engine: "error",
    };
  }
}

function languageModel() {
  const baseURL = process.env.OPENAI_BASE_URL?.trim() || undefined;
  const provider = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL,
    compatibility: baseURL ? "compatible" : "strict",
  });
  return provider(modelName());
}

function systemPrompt(): string {
  return `You are Splitnote, an invoice and payout assistant for a freelancer or small studio.
Today is ${todayUtc()} UTC.
Use the tools. Do not invent PayPal ids, amounts, or emails.
When the user wants to bill someone, call bill_client once. Collaborator percentages are numbers like 30 for 30%, and they are paid only after the invoice is paid. Do not claim a payout was sent unless a tool result says so.
When they ask who owes them, call who_owes_me. When they ask about income, revenue, or what they collected, call monthly_income. Omit month for "this month".
After tools return, explain the result in a few plain sentences. Keep every amount, email, due date, and PayPal id exactly as the tool reported it.
If a tool returns an error, explain that error and the single next step. Do not retry the same bill_client call.`;
}
