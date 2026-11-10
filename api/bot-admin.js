// Authenticated status and one-date legacy import. Import copies Blob into Redis.
// It does not delete Blob objects and it does not run from a stats read.
import { parseBody } from "./bot-model.js";
import { isRealDate } from "./bot-dates.js";
import { preservedWindow, planLegacyImport, readLegacyDate, createVercelBlobIo } from "./bot-legacy.js";
import { LAST_PRESERVED_DAY, COUNTER_FIRST_DAY } from "./bot-dates.js";
import {
  HIT_COMMANDS, KEY_PREFIX, MAX_MONTHLY_HIT_BUDGET, READ_COMMAND_RESERVE,
  STATS_COMMANDS, UPSTASH_FREE_MONTHLY_COMMANDS, budgetKey, commandsFromEnv,
  isHttpsRedisUrl, resolveBudget, writeLegacy,
} from "./bot-store.js";
import { bearerOk, logFailure, sendJson, unavailableBody } from "./bot-http.js";
import { etDate } from "./_bots.js";

async function defaultBlobIo() {
  const mod = await import("@vercel/blob");
  return createVercelBlobIo(mod);
}

function accounting(budget) {
  return {
    commandsPerAcceptedHit: HIT_COMMANDS,
    commandsPerStatsRead: STATS_COMMANDS,
    blobAdvancedOpsPerCollect: 0,
    blobAdvancedOpsPerStatsRead: 0,
    instanceMultiplier: 1,
    monthlyHitBudget: budget.limit,
    monthlyHitBudgetClamped: budget.clamped,
    monthlyHitBudgetInvalid: budget.invalid,
    maxMonthlyHitBudget: MAX_MONTHLY_HIT_BUDGET,
    readCommandReserve: READ_COMMAND_RESERVE,
    upstashFreeMonthlyCommands: UPSTASH_FREE_MONTHLY_COMMANDS,
    keyPrefix: KEY_PREFIX,
  };
}

export async function handleAdmin(req, res, deps) {
  const env = deps.env || {};
  if (!bearerOk(req.headers, env.BOT_STATS_TOKEN)) {
    res.statusCode = 401; res.setHeader("cache-control", "no-store"); res.end(); return;
  }
  const budget = resolveBudget(env.BOT_COUNTER_MONTHLY_HIT_BUDGET);
  const now = deps.now ? deps.now() : new Date();
  if (req.method === "GET" || req.method === "HEAD") {
    return sendStatus(req, res, deps, env, budget, now);
  }
  if (req.method !== "POST") { res.statusCode = 405; res.setHeader("cache-control", "no-store"); res.end(); return; }
  const body = parseBody(req.body) || {};
  if (body.action === "status") return sendStatus(req, res, deps, env, budget, now);
  if (body.action !== "import-legacy") {
    sendJson(res, 400, { available: true, wrote: false, total: null, reason: "bad_action" });
    return;
  }
  if (!isRealDate(body.date) || !preservedWindow(body.date)) {
    sendJson(res, 400, { available: true, wrote: false, total: null, reason: isRealDate(body.date) ? "outside_preserved_window" : "bad_date" });
    return;
  }
  const commands = deps.commands;
  if (!commands) {
    sendJson(res, 503, unavailableBody("counter_unconfigured", { wrote: false, date: body.date }), { retryAfter: 60 });
    return;
  }
  const io = deps.blobIo || await defaultBlobIo();
  let read;
  try {
    read = await readLegacyDate(body.date, io);
  } catch (error) {
    logFailure("bot-admin", error);
    sendJson(res, 503, unavailableBody("blob_unavailable", { wrote: false, date: body.date, total: null }), { retryAfter: 60 });
    return;
  }
  const plan = planLegacyImport(read, { date: body.date, acknowledgeEmpty: body.acknowledgeEmpty === true });
  if (!plan.write) {
    const status = plan.http;
    const payload = {
      available: plan.reason !== "blob_unavailable",
      wrote: false,
      date: body.date,
      total: null,
      reason: plan.reason,
      blob: plan.ops,
      dailyTotal: plan.dailyTotal ?? null,
      olderRawTotal: plan.olderRawTotal ?? null,
      laterRawTotal: plan.laterRawTotal ?? null,
      preservedTotal: plan.preservedTotal ?? null,
    };
    if (plan.reason === "blob_unavailable") {
      sendJson(res, status, unavailableBody("blob_unavailable", payload), { retryAfter: 60 });
      return;
    }
    sendJson(res, status, payload);
    return;
  }
  try {
    await writeLegacy(commands, body.date, plan.payload);
  } catch (error) {
    logFailure("bot-admin", error);
    sendJson(res, 503, unavailableBody(error.reason || "counter_unavailable", { wrote: false, date: body.date }), { retryAfter: 60 });
    return;
  }
  sendJson(res, 200, {
    available: true,
    wrote: true,
    date: body.date,
    total: plan.total,
    incomplete: plan.incomplete,
    rawIncluded: plan.rawIncluded,
    rawSkipped: plan.rawSkipped,
    blob: plan.ops,
    redisCommands: 1,
    deletedBlobObjects: 0,
  });
}

async function sendStatus(req, res, deps, env, budget, now) {
  const commands = deps.commands;
  const base = {
    redisConfigured: Boolean(commands),
    liveDate: isRealDate(env.BOT_COUNTER_LIVE_DATE || "") ? env.BOT_COUNTER_LIVE_DATE : null,
    liveDateValid: isRealDate(env.BOT_COUNTER_LIVE_DATE || ""),
    preserved: { firstDay: COUNTER_FIRST_DAY, lastDay: LAST_PRESERVED_DAY },
    gap: "Hits after the evening of 2026-11-06 America/New_York, through the deploy that sets BOT_COUNTER_LIVE_DATE, were not stored.",
    blobProbed: false,
    accounting: accounting(budget),
    today: etDate(now),
  };
  if (!commands) {
    sendJson(res, 503, unavailableBody("counter_unconfigured", base), { retryAfter: 60 });
    return;
  }
  if (!isHttpsRedisUrl(env.UPSTASH_REDIS_REST_URL || "")) {
    sendJson(res, 503, unavailableBody("counter_unconfigured", base), { retryAfter: 60 });
    return;
  }
  try {
    const month = etDate(now).slice(0, 7);
    const usedRaw = await commands.exec(["GET", budgetKey(month)]);
    const used = usedRaw == null || usedRaw === "" ? 0 : Number(usedRaw);
    if (!Number.isInteger(used) || used < 0) throw new Error("budget");
    const body = { ...base, available: true, budget: { month, used, limit: budget.limit, exhausted: used >= budget.limit } };
    if (req.method === "HEAD") { res.statusCode = 200; res.setHeader("cache-control", "no-store"); res.end(); return; }
    sendJson(res, 200, body);
  } catch (error) {
    logFailure("bot-admin", error);
    sendJson(res, 503, unavailableBody(error.reason || "counter_unavailable", base), { retryAfter: 60 });
  }
}

export default function handler(req, res) {
  return handleAdmin(req, res, { env: process.env, commands: commandsFromEnv(process.env) });
}
