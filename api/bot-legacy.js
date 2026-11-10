// One-date Blob read. Never deletes, never writes a zero over a failed read.
import { normalizeStoredRows, mergeLegacy } from "./bot-model.js";
import { COUNTER_FIRST_DAY, LAST_PRESERVED_DAY, isRealDate } from "./bot-dates.js";

const MAX_LIST_PAGES = 1;
const MAX_RAW = 1000;

export function preservedWindow(date) {
  return isRealDate(date) && date >= COUNTER_FIRST_DAY && date <= LAST_PRESERVED_DAY;
}

function parseJsonBody(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.rows)) return { ok: false };
  return normalizeStoredRows(json.rows);
}

export async function readLegacyDate(date, io) {
  const ops = { advancedLists: 0, simpleGets: 0 };
  let dailyResult;
  try {
    ops.simpleGets++;
    dailyResult = await io.get(`bots/daily/${date}.json`);
  } catch {
    return { ok: false, reason: "blob_unavailable", ops };
  }
  let daily = null;
  if (!dailyResult || dailyResult.state === "absent") {
    daily = null;
  } else if (dailyResult.state === "unreadable") {
    return { ok: false, reason: "legacy_unreadable", ops };
  } else if (dailyResult.state !== "ok") {
    return { ok: false, reason: "blob_unavailable", ops };
  } else {
    const norm = parseJsonBody(dailyResult.json);
    if (!norm.ok) return { ok: false, reason: "legacy_unreadable", ops };
    daily = { rows: norm.rows, uploadedAt: dailyResult.uploadedAt || null };
  }

  let listed;
  try {
    ops.advancedLists++;
    listed = await io.list(`bots/raw/${date}/`);
  } catch {
    return { ok: false, reason: "blob_unavailable", ops };
  }
  if (!listed || listed.state === "error") return { ok: false, reason: "blob_unavailable", ops };
  if (listed.state === "truncated" || listed.truncated) {
    return { ok: false, reason: "legacy_list_truncated", ops };
  }
  const metas = listed.blobs || [];
  if (metas.length > MAX_RAW) return { ok: false, reason: "legacy_list_truncated", ops };

  const raw = [];
  for (const meta of metas) {
    let got;
    try {
      ops.simpleGets++;
      got = await io.get(meta.pathname);
    } catch {
      return { ok: false, reason: "blob_unavailable", ops };
    }
    if (!got || got.state === "error") return { ok: false, reason: "blob_unavailable", ops };
    if (got.state === "absent" || got.state === "unreadable") {
      return { ok: false, reason: "legacy_unreadable", ops };
    }
    const norm = parseJsonBody(got.json);
    if (!norm.ok) return { ok: false, reason: "legacy_unreadable", ops };
    raw.push({ rows: norm.rows, uploadedAt: meta.uploadedAt || got.uploadedAt || null });
  }
  return { ok: true, ops, daily, raw };
}

export function planLegacyImport(read, { date, acknowledgeEmpty }) {
  const ops = read.ops || { advancedLists: 0, simpleGets: 0 };
  if (!read.ok) {
    const http = read.reason === "blob_unavailable" ? 503 : 409;
    return { write: false, http, reason: read.reason, total: null, ops };
  }
  if (!read.daily && read.raw.length === 0) {
    return { write: false, http: 200, reason: "no_legacy_objects", total: null, ops };
  }
  const merged = mergeLegacy({ daily: read.daily, raw: read.raw });
  if (!merged.ok) {
    return {
      write: false,
      http: 409,
      reason: merged.reason,
      total: null,
      ops,
      dailyTotal: merged.dailyTotal ?? null,
      olderRawTotal: merged.olderRawTotal ?? null,
      laterRawTotal: merged.laterRawTotal ?? null,
    };
  }
  if (merged.total === 0 && !acknowledgeEmpty) {
    return {
      write: false,
      http: 409,
      reason: "empty_refused",
      total: null,
      preservedTotal: 0,
      ops,
      dailyTotal: merged.dailyTotal,
      olderRawTotal: merged.olderRawTotal,
      laterRawTotal: merged.laterRawTotal,
    };
  }
  const payload = {
    v: 1,
    date,
    rows: merged.rows,
    incomplete: date === LAST_PRESERVED_DAY,
    coverage: "preserved_blob",
    measuredEmpty: merged.total === 0,
    rawIncluded: merged.rawIncluded,
    rawSkipped: merged.rawSkipped,
  };
  return {
    write: true,
    http: 200,
    reason: null,
    total: merged.total,
    payload,
    ops,
    rawIncluded: merged.rawIncluded,
    rawSkipped: merged.rawSkipped,
    dailyTotal: merged.dailyTotal,
    olderRawTotal: merged.olderRawTotal,
    laterRawTotal: merged.laterRawTotal,
    incomplete: payload.incomplete,
  };
}

export function createVercelBlobIo(mod, env = process.env) {
  return {
    async get(pathname) {
      let result;
      try {
        result = await mod.get(pathname, { access: "private", useCache: false });
      } catch (e) {
        if (e?.name === "BlobNotFoundError") return { state: "absent" };
        throw e;
      }
      if (!result || result.statusCode === 404) return { state: "absent" };
      if (result.statusCode !== 200 || !result.stream) return { state: "error" };
      let json;
      try { json = JSON.parse(await new Response(result.stream).text()); }
      catch { return { state: "unreadable" }; }
      const uploadedAt = result.blob?.uploadedAt ? new Date(result.blob.uploadedAt).toISOString() : null;
      return { state: "ok", json, uploadedAt };
    },
    async list(prefix) {
      const previous = env.VERCEL_BLOB_RETRIES;
      env.VERCEL_BLOB_RETRIES = "0";
      try {
        const page = await mod.list({ prefix, limit: 1000 });
        const blobs = (page?.blobs || []).map((b) => ({
          pathname: b.pathname,
          uploadedAt: b.uploadedAt ? new Date(b.uploadedAt).toISOString() : null,
        }));
        if (page?.hasMore) return { state: "truncated", blobs, truncated: true };
        return { state: "ok", blobs, truncated: false };
      } finally {
        if (previous === undefined) delete env.VERCEL_BLOB_RETRIES;
        else env.VERCEL_BLOB_RETRIES = previous;
      }
    },
  };
}

export const legacyListPageCap = MAX_LIST_PAGES;
