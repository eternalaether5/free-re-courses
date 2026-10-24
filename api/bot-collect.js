// Central bot-hit counter (lives only on lowlevellibrary.com / free-re-courses).
// Hits are aggregated in memory and written to a private Vercel Blob store as ONE small
// JSON chunk per flush window, never one write per hit, to stay far inside Hobby's free
// Blob quota (2,000 advanced ops/month). Stored fields: date (ET), site, bot name, path,
// HTTP status, count. No IPs, no UA strings, no personal data.
import { put } from "@vercel/blob";
import { waitUntil } from "@vercel/functions";
import { etDate, cleanPath } from "./_bots.js";

const FLUSH_DELAY_MS = 120_000;   // aggregate for 2 minutes after the first buffered hit
const DAILY_FLUSH_CAP = 40;       // hard cap on Blob writes per instance per ET day
const SITES = new Set(["main", "binrev", "exploit", "firmware"]);
const BOT_RE = /^[A-Za-z0-9._-]{1,40}$/;

let buf = new Map();              // "date\tsite\tbot\tpath\tstatus" -> count
let pending = null;
let capDay = etDate(), flushesToday = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function flush() {
  const today = etDate();
  if (today !== capDay) { capDay = today; flushesToday = 0; }
  if (buf.size === 0) return;
  if (flushesToday >= DAILY_FLUSH_CAP) return; // keep buffering; next allowed flush carries it
  const snapshot = buf; buf = new Map();
  const byDate = new Map();
  for (const [k, n] of snapshot) {
    const [date, site, bot, path, status] = k.split("\t");
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push([site, bot, path, Number(status), n]);
  }
  for (const [date, rows] of byDate) {
    flushesToday++;
    const name = `bots/raw/${date}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    try {
      await put(name, JSON.stringify({ v: 1, date, rows }), {
        access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: false,
      });
    } catch (e) {
      // put back so the next flush retries
      for (const [site, bot, path, status, n] of rows) {
        const k = [date, site, bot, path, status].join("\t");
        buf.set(k, (buf.get(k) || 0) + n);
      }
      console.error("bot-collect flush failed", e?.message);
    }
  }
}

function schedule() {
  if (!pending) {
    pending = (async () => {
      await sleep(FLUSH_DELAY_MS);
      try { await flush(); } finally { pending = null; }
    })();
  }
  waitUntil(pending);
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  if (!process.env.BOT_COLLECT_KEY || req.headers["x-lll-collect-key"] !== process.env.BOT_COLLECT_KEY) {
    res.statusCode = 401; return res.end();
  }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const site = body?.site, bot = body?.bot;
  if (!SITES.has(site) || !BOT_RE.test(String(bot || ""))) { res.statusCode = 400; return res.end(); }
  const path = cleanPath(body.path);
  const status = Number.isInteger(body.status) ? body.status : 0;
  const k = [etDate(), site, bot, path, status].join("\t");
  if (buf.size < 20000 || buf.has(k)) buf.set(k, (buf.get(k) || 0) + 1);
  schedule();
  res.statusCode = 202;
  res.setHeader("cache-control", "no-store");
  return res.end();
}
