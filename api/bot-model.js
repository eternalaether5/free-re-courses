// Pure counter rules: validation, legacy merge, and the stats document.
// A missing store never becomes total 0. Only an explicit measurement does.
import { cleanPath } from "./_bots.js";
import { LAST_PRESERVED_DAY, classifyUnmeasured } from "./bot-dates.js";

export const SITES = new Set(["main", "binrev", "exploit", "firmware"]);
export const SITE_HOST = {
  main: "lowlevellibrary.com",
  binrev: "binrev.lowlevellibrary.com",
  exploit: "exploit.lowlevellibrary.com",
  firmware: "firmware.lowlevellibrary.com",
};
const BOT_RE = /^[A-Za-z0-9._-]{1,40}$/;

export function parseBody(body) {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    if (!body) return null;
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (typeof body !== "object" || Array.isArray(body)) return null;
  return body;
}

export function validateEvent(body) {
  const parsed = parseBody(body);
  if (!parsed || !SITES.has(parsed.site) || !BOT_RE.test(String(parsed.bot ?? ""))) return null;
  const status = Number.isSafeInteger(parsed.status) ? parsed.status : 0;
  return { site: parsed.site, bot: String(parsed.bot), path: cleanPath(parsed.path), status };
}

export function normalizeStoredRows(rows) {
  if (!Array.isArray(rows)) return { ok: false };
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 5) return { ok: false };
    const [site, bot, path, status, n] = row;
    if (!SITES.has(site) || typeof bot !== "string" || !BOT_RE.test(bot)) return { ok: false };
    if (typeof path !== "string" || path.length < 1 || path.length > 200 || !path.startsWith("/")) return { ok: false };
    if (!Number.isSafeInteger(status) || !Number.isSafeInteger(n) || n < 0) return { ok: false };
    out.push([site, bot, path, status, n]);
  }
  return { ok: true, rows: out };
}

function sumRows(rows) {
  let n = 0;
  for (const row of rows) n += row[4];
  return n;
}

function combineRows(groups) {
  const map = new Map();
  for (const rows of groups) {
    for (const [site, bot, path, status, n] of rows) {
      const k = JSON.stringify([site, bot, path, status]);
      map.set(k, (map.get(k) || 0) + n);
    }
  }
  return [...map.entries()]
    .map(([k, n]) => {
      const [site, bot, path, status] = JSON.parse(k);
      return [site, bot, path, status, n];
    })
    .sort((a, b) => {
      for (let i = 0; i < 4; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return 0;
    });
}

// Daily files written by the old compactor already include raw chunks that
// existed when the daily object was uploaded. Adding those chunks again would
// double count. Chunks uploaded later are new. If the older raw sum is larger
// than the daily file, the daily file is not a superset: refuse rather than guess.
export function mergeLegacy({ daily, raw }) {
  const chunks = raw || [];
  const dailyTime = daily?.uploadedAt ? Date.parse(daily.uploadedAt) : NaN;
  if (daily && chunks.length && Number.isNaN(dailyTime)) {
    return { ok: false, reason: "daily_missing_uploaded_at" };
  }
  const older = [];
  const later = [];
  for (const chunk of chunks) {
    if (!daily) { later.push(chunk); continue; }
    const t = chunk.uploadedAt ? Date.parse(chunk.uploadedAt) : NaN;
    if (Number.isNaN(t)) return { ok: false, reason: "raw_missing_uploaded_at" };
    if (t <= dailyTime) older.push(chunk);
    else later.push(chunk);
  }
  const dailyRows = daily?.rows || [];
  const dailyTotal = daily ? sumRows(dailyRows) : null;
  const olderRawTotal = sumRows(older.flatMap((c) => c.rows));
  const laterRows = later.flatMap((c) => c.rows);
  const laterRawTotal = sumRows(laterRows);
  if (daily && olderRawTotal > dailyTotal) {
    return { ok: false, reason: "legacy_conflict", dailyTotal, olderRawTotal, laterRawTotal };
  }
  const rows = combineRows([daily ? dailyRows : [], laterRows]);
  return {
    ok: true,
    rows,
    total: sumRows(rows),
    dailyTotal,
    olderRawTotal,
    laterRawTotal,
    rawIncluded: later.length,
    rawSkipped: older.length,
    usedDaily: Boolean(daily),
  };
}

export function aggregate(rows) {
  const counts = new Map();
  for (const [site, bot, path, status, n] of rows) {
    if (n <= 0) continue;
    const k = JSON.stringify([site, bot, path, status]);
    counts.set(k, (counts.get(k) || 0) + n);
  }
  const sites = {};
  const byBot = {};
  let total = 0;
  const ordered = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [k, n] of ordered) {
    const [site, bot, path, status] = JSON.parse(k);
    total += n;
    byBot[bot] = (byBot[bot] || 0) + n;
    const s = (sites[site] ||= { host: SITE_HOST[site] || site, total: 0, bots: {} });
    s.total += n;
    const b = (s.bots[bot] ||= { total: 0, pages: {} });
    b.total += n;
    const pk = status === 200 ? path : `${path} [${status}]`;
    b.pages[pk] = (b.pages[pk] || 0) + n;
  }
  return { total, byBot, sites };
}

export function hashResultToObject(result) {
  if (result == null) return {};
  if (Array.isArray(result)) {
    if (result.length % 2 !== 0) return null;
    const out = {};
    for (let i = 0; i < result.length; i += 2) out[String(result[i])] = result[i + 1];
    return out;
  }
  if (typeof result === "object") return result;
  return null;
}

export function rowsFromHash(hash) {
  if (hash == null) return { ok: false };
  const rows = [];
  for (const [field, value] of Object.entries(hash)) {
    let parsed;
    try { parsed = JSON.parse(field); } catch { return { ok: false }; }
    const norm = normalizeStoredRows([[parsed?.[0], parsed?.[1], parsed?.[2], Number(parsed?.[3]), Number(value)]]);
    if (!Array.isArray(parsed) || parsed.length !== 4 || !norm.ok) return { ok: false };
    const n = norm.rows[0][4];
    if (n < 0) return { ok: false };
    if (n === 0) continue;
    rows.push(norm.rows[0]);
  }
  return { ok: true, rows };
}

export function parseLegacyValue(raw) {
  if (raw == null) return { ok: true, present: false };
  let data = raw;
  if (typeof raw === "string") {
    try { data = JSON.parse(raw); } catch { return { ok: false }; }
  }
  if (!data || typeof data !== "object" || data.v !== 1) return { ok: false };
  const norm = normalizeStoredRows(data.rows);
  if (!norm.ok) return { ok: false };
  return {
    ok: true,
    present: true,
    rows: norm.rows,
    incomplete: Boolean(data.incomplete),
    measuredEmpty: Boolean(data.measuredEmpty),
    rawIncluded: Number.isInteger(data.rawIncluded) ? data.rawIncluded : null,
    rawSkipped: Number.isInteger(data.rawSkipped) ? data.rawSkipped : null,
  };
}

function budgetView(date, snapshot, limit) {
  return {
    month: date.slice(0, 7),
    used: snapshot.budgetUsed,
    limit,
    commandsPerAcceptedHit: 2,
    commandsPerStatsRead: 3,
  };
}

export function buildStats({ date, today, liveDate, limit, snapshot }) {
  const budgetExhausted = limit >= 0 && snapshot.budgetUsed >= limit;
  const liveRows = snapshot.liveRows.filter((row) => row[4] > 0);
  const legacy = snapshot.legacy;
  const legacyRows = legacy.present ? legacy.rows.filter((row) => row[4] > 0) : [];
  const partialDay = date === today;
  const body = {
    date,
    timezone: "America/New_York",
    partialDay,
    available: true,
    measured: false,
    total: null,
    totalMeaning: null,
    byBot: null,
    sites: null,
    reason: null,
    incomplete: false,
    incompleteReason: null,
    budgetExhausted,
    budget: budgetView(date, snapshot, limit),
    sources: { live: liveRows.length > 0, legacy: legacyRows.length > 0 },
    coverage: null,
  };
  if (date > today) {
    body.reason = "future";
    return body;
  }
  const explicitEmpty = legacy.present && legacy.measuredEmpty && liveRows.length === 0 && legacyRows.length === 0;
  if (liveRows.length === 0 && legacyRows.length === 0 && !explicitEmpty) {
    body.reason = classifyUnmeasured(date, liveDate);
    return body;
  }
  if (explicitEmpty) {
    body.measured = true;
    body.total = 0;
    body.totalMeaning = "explicit_empty";
    body.byBot = {};
    body.sites = {};
    body.coverage = "explicit_empty_legacy";
    body.incomplete = date === LAST_PRESERVED_DAY || budgetExhausted;
    body.incompleteReason = date === LAST_PRESERVED_DAY ? "blob_suspended_during_day" : budgetExhausted ? "monthly_budget" : null;
    return body;
  }
  const agg = aggregate([...legacyRows, ...liveRows]);
  body.measured = true;
  body.total = agg.total;
  body.byBot = agg.byBot;
  body.sites = agg.sites;
  body.coverage = legacyRows.length && liveRows.length ? "preserved_blob_plus_redis" : legacyRows.length ? "preserved_blob" : "redis";
  if (date === LAST_PRESERVED_DAY || legacy.incomplete) {
    body.incomplete = true;
    body.incompleteReason = "blob_suspended_during_day";
  }
  if (budgetExhausted) {
    body.incomplete = true;
    body.incompleteReason = body.incompleteReason || "monthly_budget";
  }
  body.totalMeaning = body.incomplete ? "preserved_lower_bound" : partialDay ? "open_day" : "stored_hits";
  return body;
}
