// Protected read endpoint for bot-hit counts.
// GET /api/bot-stats?date=YYYY-MM-DD|yesterday|today   (ET dates; default: yesterday)
// Header: Authorization: Bearer <BOT_STATS_TOKEN>
// For closed days it compacts the raw chunks into bots/daily/<date>.json (1 write) and
// deletes the chunks (free), so later reads cost one list + one get.
import { list, get, put, del } from "@vercel/blob";
import { etDate } from "./_bots.js";

const SITE_HOST = { main: "lowlevellibrary.com", binrev: "binrev.lowlevellibrary.com", exploit: "exploit.lowlevellibrary.com", firmware: "firmware.lowlevellibrary.com" };

async function readJson(pathname) {
  const r = await get(pathname, { access: "private", useCache: false });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

function addRows(map, rows) {
  for (const [site, bot, path, status, n] of rows) {
    const k = [site, bot, path, status].join("\t");
    map.set(k, (map.get(k) || 0) + n);
  }
}

export default async function handler(req, res) {
  const tok = process.env.BOT_STATS_TOKEN;
  if (!tok || req.headers["authorization"] !== `Bearer ${tok}`) { res.statusCode = 401; return res.end(); }
  const url = new URL(req.url, "https://lowlevellibrary.com");
  const now = new Date();
  const today = etDate(now);
  let date = url.searchParams.get("date") || "yesterday";
  if (date === "today") date = today;
  if (date === "yesterday") {
    // ET calendar yesterday: step back from ET noon to avoid DST edges
    const [y, m, d] = today.split("-").map(Number);
    date = new Date(Date.UTC(y, m - 1, d - 1, 12)).toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.statusCode = 400; return res.end("bad date"); }

  const counts = new Map();
  const daily = await readJson(`bots/daily/${date}.json`).catch(() => null);
  if (daily?.rows) addRows(counts, daily.rows);
  const raw = [];
  let cursor;
  do {
    const page = await list({ prefix: `bots/raw/${date}/`, cursor, limit: 1000 });
    raw.push(...page.blobs); cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  for (const b of raw) { const j = await readJson(b.pathname).catch(() => null); if (j?.rows) addRows(counts, j.rows); }

  const closed = date < today;
  let compacted = false;
  if (closed && raw.length) {
    const rows = [...counts].map(([k, n]) => { const [s, b, p, st] = k.split("\t"); return [s, b, p, Number(st), n]; });
    await put(`bots/daily/${date}.json`, JSON.stringify({ v: 1, date, rows }), { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true });
    await del(raw.map((b) => b.url));
    compacted = true;
  }

  const sites = {}; const byBot = {}; let total = 0;
  for (const [k, n] of counts) {
    const [site, bot, path, status] = k.split("\t");
    total += n; byBot[bot] = (byBot[bot] || 0) + n;
    const s = (sites[site] ||= { host: SITE_HOST[site] || site, total: 0, bots: {} });
    s.total += n;
    const b = (s.bots[bot] ||= { total: 0, pages: {} });
    b.total += n;
    const pk = status === "200" ? path : `${path} [${status}]`;
    b.pages[pk] = (b.pages[pk] || 0) + n;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ date, timezone: "America/New_York", partialDay: !closed, total, byBot, sites, rawChunks: raw.length, compacted }, null, 2));
}
