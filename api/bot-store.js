// Durable hit log. One accepted hit is two Redis commands in one HTTP request,
// on every isolate. Nothing is buffered in process memory.
//
// Upstash Free, checked 2026-11-10: 500,000 commands / month, then an error
// (a payment method moves the database onto pay-as-you-go — do not add one).
// Steady state: hits*2 + statsReads*3. Default ceiling 200,000 hits = 400,000
// commands, leaving 60,000 for reads and about 40,000 of slack. The ceiling
// cannot be configured past 220,000, so this process cannot spend the free
// allowance by itself. Rejected hits are not stored and are not zeros.
import { hashResultToObject, parseLegacyValue, rowsFromHash } from "./bot-model.js";

export const UPSTASH_FREE_MONTHLY_COMMANDS = 500_000;
export const HIT_COMMANDS = 2;
export const STATS_COMMANDS = 3;
export const READ_COMMAND_RESERVE = 60_000;
export const MAX_MONTHLY_HIT_BUDGET = Math.floor((UPSTASH_FREE_MONTHLY_COMMANDS - READ_COMMAND_RESERVE) / HIT_COMMANDS);
export const DEFAULT_MONTHLY_HIT_BUDGET = 200_000;
export const KEY_PREFIX = "lll:bot:v1";

export const liveKey = (date) => `${KEY_PREFIX}:live:${date}`;
export const legacyKey = (date) => `${KEY_PREFIX}:legacy:${date}`;
export const budgetKey = (month) => `${KEY_PREFIX}:budget:${month}`;

export class CounterError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "CounterError";
    this.reason = reason;
  }
}

export function resolveBudget(envValue) {
  if (envValue == null || envValue === "") {
    return { limit: DEFAULT_MONTHLY_HIT_BUDGET, clamped: false, invalid: false };
  }
  if (!/^\d+$/.test(String(envValue).trim())) {
    return { limit: DEFAULT_MONTHLY_HIT_BUDGET, clamped: false, invalid: true };
  }
  const n = Number(envValue);
  if (n > MAX_MONTHLY_HIT_BUDGET) return { limit: MAX_MONTHLY_HIT_BUDGET, clamped: true, invalid: false };
  return { limit: n, clamped: false, invalid: false };
}

export function isHttpsRedisUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.username === "" && u.password === "" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

export function classifyProvider(status, errorText) {
  const msg = String(errorText || "");
  if (status === 429 || /quota|limit exceeded|max requests|daily request|monthly command|plan limit|bandwidth limit|command limit/i.test(msg)) {
    return "quota";
  }
  return "counter_unavailable";
}

function asCounterError(e) {
  if (e instanceof CounterError) return e;
  return new CounterError("counter_unavailable", "command_failed");
}

function circuit(commands) {
  if (!commands.budgetCircuit) commands.budgetCircuit = { active: false, month: "", limit: -1 };
  return commands.budgetCircuit;
}

export async function recordHit(commands, { date, site, bot, path, status, limit }) {
  const month = date.slice(0, 7);
  const gate = circuit(commands);
  if (gate.active && gate.month === month && gate.limit === limit) {
    return { ok: false, reason: "monthly_budget", commands: 0 };
  }
  const field = JSON.stringify([site, bot, path, status]);
  const hash = liveKey(date);
  const counter = budgetKey(month);
  let used;
  try {
    const results = await commands.pipeline([
      ["INCR", counter],
      ["HINCRBY", hash, field, "1"],
    ]);
    used = Number(results[0]);
  } catch (e) {
    throw asCounterError(e);
  }
  if (!Number.isInteger(used)) throw new CounterError("counter_unavailable");
  if (used > limit) {
    try {
      const undone = await commands.pipeline([
        ["DECR", counter],
        ["HINCRBY", hash, field, "-1"],
      ]);
      let spent = 4;
      if (Number(undone[1]) <= 0) {
        await commands.exec(["HDEL", hash, field]);
        spent = 5;
      }
      gate.active = true;
      gate.month = month;
      gate.limit = limit;
      return { ok: false, reason: "monthly_budget", commands: spent };
    } catch (e) {
      throw asCounterError(e);
    }
  }
  return { ok: true, used, commands: HIT_COMMANDS };
}

export async function readSnapshot(commands, date) {
  let liveRaw;
  let legacyRaw;
  let budgetRaw;
  try {
    const results = await commands.pipeline([
      ["HGETALL", liveKey(date)],
      ["GET", legacyKey(date)],
      ["GET", budgetKey(date.slice(0, 7))],
    ]);
    liveRaw = results[0];
    legacyRaw = results[1];
    budgetRaw = results[2];
  } catch (e) {
    throw asCounterError(e);
  }
  const hash = hashResultToObject(liveRaw);
  if (hash == null) throw new CounterError("counter_unavailable");
  const live = rowsFromHash(hash);
  if (!live.ok) throw new CounterError("counter_unavailable");
  const legacy = parseLegacyValue(legacyRaw);
  if (!legacy.ok) throw new CounterError("counter_unavailable");
  const budgetUsed = budgetRaw == null || budgetRaw === "" ? 0 : Number(budgetRaw);
  if (!Number.isInteger(budgetUsed) || budgetUsed < 0) throw new CounterError("counter_unavailable");
  return { liveRows: live.rows, legacy, budgetUsed };
}

export async function writeLegacy(commands, date, payload) {
  try {
    const result = await commands.exec(["SET", legacyKey(date), JSON.stringify(payload)]);
    if (result !== "OK" && result !== true) throw new CounterError("counter_unavailable");
  } catch (e) {
    throw asCounterError(e);
  }
}

export function createMemoryCommands(state) {
  const s = state || { strings: new Map(), hashes: new Map(), ops: [] };
  function num(v) {
    if (v == null) return 0;
    const n = Number(v);
    return Number.isInteger(n) ? n : 0;
  }
  async function exec(args) {
    s.ops.push(args.map(String));
    const [cmd, key, a, b] = args;
    if (cmd === "INCR" || cmd === "DECR") {
      const v = num(s.strings.get(key)) + (cmd === "INCR" ? 1 : -1);
      s.strings.set(key, v);
      return v;
    }
    if (cmd === "GET") return s.strings.has(key) ? s.strings.get(key) : null;
    if (cmd === "SET") { s.strings.set(key, String(a)); return "OK"; }
    if (cmd === "HINCRBY") {
      let h = s.hashes.get(key);
      if (!h) { h = new Map(); s.hashes.set(key, h); }
      const v = num(h.get(a)) + Number(b);
      if (v === 0) h.delete(a);
      else h.set(a, v);
      if (h.size === 0) s.hashes.delete(key);
      return v;
    }
    if (cmd === "HDEL") {
      const h = s.hashes.get(key);
      if (h) {
        h.delete(a);
        if (h.size === 0) s.hashes.delete(key);
      }
      return 1;
    }
    if (cmd === "HGETALL") {
      const h = s.hashes.get(key);
      if (!h) return [];
      const out = [];
      for (const [field, value] of h) out.push(field, String(value));
      return out;
    }
    throw new CounterError("counter_unavailable");
  }
  const commands = {
    state: s,
    ops: s.ops,
    exec,
    async pipeline(cmds) {
      const out = [];
      for (const c of cmds) out.push(await exec(c));
      return out;
    },
  };
  return commands;
}

export function createUpstashCommands({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 800 }) {
  async function request(path, body) {
    const endpoint = new URL(url);
    endpoint.pathname = path;
    endpoint.search = "";
    endpoint.hash = "";
    let response;
    try {
      response = await fetchImpl(endpoint.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CounterError("counter_unavailable", "network");
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new CounterError("counter_unavailable", "bad_response"); }
    if (!response.ok) throw new CounterError(classifyProvider(response.status, payload?.error), "http");
    return payload;
  }
  return {
    async exec(args) {
      const payload = await request("/", args);
      if (payload?.error) throw new CounterError(classifyProvider(200, payload.error));
      return payload?.result;
    },
    async pipeline(cmds) {
      const payload = await request("/pipeline", cmds);
      if (!Array.isArray(payload)) {
        if (payload?.error) throw new CounterError(classifyProvider(200, payload.error));
        throw new CounterError("counter_unavailable");
      }
      if (payload.length !== cmds.length) throw new CounterError("counter_unavailable");
      return payload.map((item) => {
        if (!item || item.error) throw new CounterError(classifyProvider(200, item?.error));
        return item.result;
      });
    },
  };
}

let cachedCommands = null;
let cachedKey = "";

export function resetCommandCache() {
  cachedCommands = null;
  cachedKey = "";
}

export function commandsFromEnv(env, fetchImpl) {
  const url = env?.UPSTASH_REDIS_REST_URL || "";
  const token = env?.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url && !token) return null;
  if (!isHttpsRedisUrl(url) || typeof token !== "string" || token.length < 8) return null;
  const key = `${url}\n${token}`;
  if (cachedCommands && cachedKey === key) return cachedCommands;
  cachedCommands = createUpstashCommands({ url, token, fetchImpl });
  cachedKey = key;
  return cachedCommands;
}
