import assert from "node:assert/strict";
import test from "node:test";
import { EXAMPLE_PROMPTS } from "../src/lib/examples";
import { calculateSplits, dollarsToCents } from "../src/lib/money";
import { parseInstruction } from "../src/lib/parseInstruction";
import { dueDateFor } from "../src/lib/terms";

const NOW = new Date("2026-10-31T15:00:00Z");

test("the hackathon example bills Acme and schedules a 30% design split", () => {
  const parsed = parseInstruction(EXAMPLE_PROMPTS[0].text, NOW);
  assert.equal(parsed?.kind, "bill");
  if (parsed?.kind !== "bill") return;
  assert.equal(parsed.clientName, "Acme");
  assert.equal(parsed.clientEmail, "acme@example.com");
  assert.equal(parsed.amount, "1200.00");
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.description, "the October logo work");
  assert.equal(parsed.paymentTerm, "NET_15");
  assert.deepEqual(parsed.splits, [{ email: "designer@example.com", label: "designer", percent: 30 }]);
  const [line] = calculateSplits(dollarsToCents(parsed.amount), parsed.splits);
  assert.equal(line.amountCents, 36000);
});

test("two collaborators are both stored", () => {
  const parsed = parseInstruction(
    "Invoice Northwind (ap@northwind.example) $2,400 for the November site build, net-30, and pay my designer (designer@example.com) 30% and my writer (writer@example.com) 20% when they pay.",
    NOW,
  );
  assert.equal(parsed?.kind, "bill");
  if (parsed?.kind !== "bill") return;
  assert.equal(parsed.clientName, "Northwind");
  assert.equal(parsed.amount, "2400.00");
  assert.equal(parsed.paymentTerm, "NET_30");
  assert.equal(parsed.description, "the November site build");
  assert.deepEqual(
    parsed.splits.map((split) => ({ email: split.email, percent: split.percent, label: split.label })),
    [
      { email: "designer@example.com", percent: 30, label: "designer" },
      { email: "writer@example.com", percent: 20, label: "writer" },
    ],
  );
});

test("receivables and income questions are not treated as invoices", () => {
  assert.deepEqual(parseInstruction("Who still owes me?", NOW), { kind: "who_owes" });
  assert.deepEqual(parseInstruction("Show this month's income", NOW), { kind: "income" });
  assert.deepEqual(parseInstruction("income for October 2026", NOW), { kind: "income", month: "2026-10" });
  assert.deepEqual(parseInstruction("show last month's income", new Date("2026-01-15T00:00:00Z")), {
    kind: "income",
    month: "2025-12",
  });
});

test("missing details and unsupported terms ask for a clarification", () => {
  const missingEmail = parseInstruction("Bill Acme $50 for logos", NOW);
  assert.equal(missingEmail?.kind, "clarify");
  const tooMuch = parseInstruction(
    "Bill Acme (acme@example.com) $100 for work and pay my designer (designer@example.com) 80% and my writer (writer@example.com) 30%.",
    NOW,
  );
  assert.equal(tooMuch?.kind, "clarify");
  const oddTerm = parseInstruction("Bill Acme (acme@example.com) $100 for work, net-12.", NOW);
  assert.equal(oddTerm?.kind, "clarify");
  const immediate = parseInstruction(
    "Bill Acme (acme@example.com) $100 for work and pay my designer (designer@example.com) 30% immediately.",
    NOW,
  );
  assert.equal(immediate?.kind, "clarify");
});

test("unrelated text is left for the model", () => {
  assert.equal(parseInstruction("What's the weather tomorrow?", NOW), null);
});

test("net-15 from October 31 is due November 15", () => {
  assert.equal(dueDateFor("NET_15", NOW), "2026-11-15");
  assert.equal(dueDateFor("DUE_ON_RECEIPT", NOW), "2026-10-31");
});
