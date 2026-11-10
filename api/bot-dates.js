// America/New_York calendar dates. Readership days follow this clock, including DST.
import { etDate } from "./_bots.js";

export const TIMEZONE = "America/New_York";
export const COUNTER_FIRST_DAY = "2026-10-24";
export const LAST_PRESERVED_DAY = "2026-11-06";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isRealDate(iso) {
  if (typeof iso !== "string" || !ISO_DATE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toISOString().slice(0, 10) === iso;
}

export function addCalendarDays(iso, delta) {
  if (!isRealDate(iso) || !Number.isInteger(delta)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta, 12)).toISOString().slice(0, 10);
}

export function resolveStatsDate(param, now = new Date()) {
  const today = etDate(now);
  let date = param == null || param === "" ? "yesterday" : String(param);
  if (date === "today") date = today;
  if (date === "yesterday") date = addCalendarDays(today, -1);
  if (!isRealDate(date)) return { ok: false };
  return { ok: true, date, today };
}

// Dates after the last preserved Blob day are an outage until BOT_COUNTER_LIVE_DATE.
// An invalid or absent live date keeps those days in the gap so they cannot become zeros.
export function classifyUnmeasured(date, liveDate) {
  if (date < COUNTER_FIRST_DAY) return "before_counter";
  if (date <= LAST_PRESERVED_DAY) return "legacy_not_imported";
  if (!isRealDate(liveDate || "") || date < liveDate) return "irrecoverable_gap";
  return "no_record";
}
