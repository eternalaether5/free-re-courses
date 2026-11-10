// Read-only daily readership. Never lists Blob, never compacts, never deletes.
// Unknown, unimported, and unstored days return total: null. They are not zeros.
import { buildStats } from "./bot-model.js";
import { resolveStatsDate } from "./bot-dates.js";
import { commandsFromEnv, readSnapshot, resolveBudget } from "./bot-store.js";
import { bearerOk, logFailure, sendJson, unavailableBody } from "./bot-http.js";

export async function handleStats(req, res, deps) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405; res.setHeader("cache-control", "no-store"); res.end(); return;
  }
  const env = deps.env || {};
  if (!bearerOk(req.headers, env.BOT_STATS_TOKEN)) {
    res.statusCode = 401; res.setHeader("cache-control", "no-store"); res.end(); return;
  }
  const url = new URL(req.url || "/", "https://lowlevellibrary.com");
  const now = deps.now ? deps.now() : new Date();
  const resolved = resolveStatsDate(url.searchParams.get("date"), now);
  if (!resolved.ok) { res.statusCode = 400; res.setHeader("cache-control", "no-store"); res.end("bad date"); return; }
  const commands = deps.commands;
  if (!commands) {
    sendJson(res, 503, unavailableBody("counter_unconfigured", { date: resolved.date, timezone: "America/New_York" }), { retryAfter: 60 });
    return;
  }
  const budget = resolveBudget(env.BOT_COUNTER_MONTHLY_HIT_BUDGET);
  try {
    const snapshot = await readSnapshot(commands, resolved.date);
    const body = buildStats({
      date: resolved.date,
      today: resolved.today,
      liveDate: env.BOT_COUNTER_LIVE_DATE,
      limit: budget.limit,
      snapshot,
    });
    if (req.method === "HEAD") { res.statusCode = 200; res.setHeader("cache-control", "no-store"); res.end(); return; }
    sendJson(res, 200, body);
  } catch (error) {
    logFailure("bot-stats", error);
    sendJson(res, 503, unavailableBody(error.reason || "counter_unavailable", {
      date: resolved.date,
      timezone: "America/New_York",
    }), { retryAfter: 60 });
  }
}

export default function handler(req, res) {
  return handleStats(req, res, { env: process.env, commands: commandsFromEnv(process.env) });
}
