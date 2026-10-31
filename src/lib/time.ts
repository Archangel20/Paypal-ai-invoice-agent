export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function todayUtc(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function currentMonth(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function parseMonth(value: string | undefined, now = new Date()): string {
  if (!value) return currentMonth(now);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error("Month must look like 2026-10.");
  }
  return value;
}

export function formatDay(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
