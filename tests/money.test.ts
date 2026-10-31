import assert from "node:assert/strict";
import test from "node:test";
import { calculateSplits, centsToDecimal, dollarsToCents } from "../src/lib/money";

test("dollarsToCents accepts commas and a leading dollar sign", () => {
  assert.equal(dollarsToCents("$1,200"), 120000);
  assert.equal(dollarsToCents("1200.50"), 120050);
  assert.equal(dollarsToCents(30), 3000);
});

test("30% of $1,200 is $360", () => {
  const [line] = calculateSplits(120000, [{ email: "designer@example.com", label: "designer", percent: 30 }]);
  assert.equal(line.amountCents, 36000);
  assert.equal(centsToDecimal(line.amountCents), "360.00");
});

test("three percentages that sum to 100 stay on the invoice total", () => {
  const lines = calculateSplits(10000, [
    { email: "a@example.com", percent: 33.33 },
    { email: "b@example.com", percent: 33.33 },
    { email: "c@example.com", percent: 33.34 },
  ]);
  assert.deepEqual(lines.map((line) => line.amountCents), [3333, 3333, 3334]);
  assert.equal(lines.reduce((sum, line) => sum + line.amountCents, 0), 10000);
});

test("the last split absorbs rounding that would exceed the invoice", () => {
  const lines = calculateSplits(5, [
    { email: "a@example.com", percent: 50 },
    { email: "b@example.com", percent: 50 },
  ]);
  assert.deepEqual(lines.map((line) => line.amountCents), [3, 2]);
});

test("percentages over 100 are rejected", () => {
  assert.throws(
    () => calculateSplits(10000, [
      { email: "a@example.com", percent: 80 },
      { email: "b@example.com", percent: 30 },
    ]),
    /at most 100/,
  );
});

test("a split that rounds to zero is rejected", () => {
  assert.throws(() => calculateSplits(1, [{ email: "a@example.com", percent: 10 }]), /\$0\.00/);
});
