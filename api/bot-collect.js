// Accept one bot hit only after Redis has stored it.
// Sisters POST {site, bot, path, status} with x-lll-collect-key and ignore the body.
// 202 means the hit is durable. 503 means it was not stored. There is no memory buffer.
import { etDate } from "./_bots.js";
import { validateEvent } from "./bot-model.js";
import { commandsFromEnv, recordHit, resolveBudget } from "./bot-store.js";
import { headerValue, logFailure, secretMatch, sendJson, unavailableBody } from "./bot-http.js";

export async function handleCollect(req, res, deps) {
  if (req.method !== "POST") { res.statusCode = 405; res.setHeader("cache-control", "no-store"); res.end(); return; }
  const env = deps.env || {};
  if (!secretMatch(headerValue(req.headers, "x-lll-collect-key"), env.BOT_COLLECT_KEY || "")) {
    res.statusCode = 401; res.setHeader("cache-control", "no-store"); res.end(); return;
  }
  const event = validateEvent(req.body);
  if (!event) { res.statusCode = 400; res.setHeader("cache-control", "no-store"); res.end(); return; }
  const commands = deps.commands;
  if (!commands) {
    sendJson(res, 503, unavailableBody("counter_unconfigured"), { retryAfter: 60 });
    return;
  }
  const now = deps.now ? deps.now() : new Date();
  const budget = resolveBudget(env.BOT_COUNTER_MONTHLY_HIT_BUDGET);
  try {
    const result = await recordHit(commands, { ...event, date: etDate(now), limit: budget.limit });
    if (!result.ok) {
      sendJson(res, 503, unavailableBody(result.reason), { retryAfter: result.reason === "monthly_budget" ? 3600 : 60 });
      return;
    }
  } catch (error) {
    logFailure("bot-collect", error);
    sendJson(res, 503, unavailableBody(error.reason || "counter_unavailable"), { retryAfter: 60 });
    return;
  }
  res.statusCode = 202;
  res.setHeader("cache-control", "no-store");
  res.end();
}

export default function handler(req, res) {
  return handleCollect(req, res, { env: process.env, commands: commandsFromEnv(process.env) });
}
