import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { etDate } from "../api/_bots.js";
import { handleAdmin } from "../api/bot-admin.js";
import { classifyUnmeasured, isRealDate, resolveStatsDate } from "../api/bot-dates.js";
import { handleCollect } from "../api/bot-collect.js";
import { createVercelBlobIo, planLegacyImport, readLegacyDate } from "../api/bot-legacy.js";
import { hashResultToObject, mergeLegacy, rowsFromHash } from "../api/bot-model.js";
import { handleStats } from "../api/bot-stats.js";
import {
  CounterError, HIT_COMMANDS, MAX_MONTHLY_HIT_BUDGET, STATS_COMMANDS,
  commandsFromEnv, createMemoryCommands, createUpstashCommands, liveKey, resetCommandCache,
} from "../api/bot-store.js";

const NOW = new Date("2026-11-10T15:00:00.000Z"); // 10:00 America/New_York
const ENV = {
  BOT_COLLECT_KEY: "collect-key-value",
  BOT_STATS_TOKEN: "stats-token-value",
  BOT_COUNTER_LIVE_DATE: "2026-11-10",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "test-token-not-secret",
};

function resCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b == null ? "" : String(b); },
  };
}

async function call(handler, req) {
  const res = resCapture();
  await handler(req, res);
  let json = null;
  if (res.body.startsWith("{")) json = JSON.parse(res.body);
  return Object.assign(res, { json });
}

function collectReq(body, headers = {}) {
  return {
    method: "POST",
    url: "/api/bot-collect",
    headers: { "x-lll-collect-key": ENV.BOT_COLLECT_KEY, ...headers },
    body,
  };
}

function statsReq(date = "yesterday") {
  return {
    method: "GET",
    url: `/api/bot-stats?date=${date}`,
    headers: { authorization: `Bearer ${ENV.BOT_STATS_TOKEN}` },
  };
}

function deps(commands, extra = {}) {
  return { env: { ...ENV, ...extra.env }, commands, now: () => extra.now || NOW, blobIo: extra.blobIo };
}

const hit = { site: "main", bot: "GPTBot", path: "/courses/x/", status: 200 };

describe("dates and DST boundaries", () => {
  it("uses the America/New_York calendar across the 2026 transitions", () => {
    assert.equal(etDate(new Date("2026-11-01T03:30:00.000Z")), "2026-10-31");
    assert.equal(etDate(new Date("2026-11-01T04:30:00.000Z")), "2026-11-01");
    assert.equal(etDate(new Date("2026-11-01T05:30:00.000Z")), "2026-11-01");
    assert.equal(etDate(new Date("2026-11-01T06:30:00.000Z")), "2026-11-01");
    assert.equal(etDate(new Date("2026-03-08T04:30:00.000Z")), "2026-03-07");
    assert.equal(etDate(new Date("2026-03-08T06:30:00.000Z")), "2026-03-08");
    assert.equal(etDate(new Date("2026-03-08T07:30:00.000Z")), "2026-03-08");
    assert.equal(resolveStatsDate("yesterday", new Date("2026-03-08T07:30:00.000Z")).date, "2026-03-07");
    assert.equal(resolveStatsDate("yesterday", new Date("2026-01-01T17:00:00.000Z")).date, "2025-12-31");
    assert.equal(resolveStatsDate("yesterday", new Date("2026-03-01T17:00:00.000Z")).date, "2026-02-28");
    assert.equal(isRealDate("2026-02-31"), false);
  });

  it("stores a hit on the ET date and rolls the monthly budget at ET midnight", async () => {
    const commands = createMemoryCommands();
    const before = new Date("2026-12-01T04:30:00.000Z"); // 23:30 ET Nov 30
    const after = new Date("2026-12-01T05:30:00.000Z"); // 00:30 ET Dec 1
    await handleCollect(collectReq(hit), resCapture(), deps(commands, { now: before }));
    await handleCollect(collectReq({ ...hit, site: "firmware" }), resCapture(), deps(commands, { now: after }));
    assert.equal(commands.state.strings.get("lll:bot:v1:budget:2026-11"), 1);
    assert.equal(commands.state.strings.get("lll:bot:v1:budget:2026-12"), 1);
    assert.ok(commands.state.hashes.has(liveKey("2026-11-30")));
    assert.ok(commands.state.hashes.has(liveKey("2026-12-01")));
  });
});

describe("collection contract shared with the sister sites", () => {
  it("accepts main, binrev, exploit, and firmware and rejects anything else", async () => {
    const commands = createMemoryCommands();
    for (const site of ["main", "binrev", "exploit", "firmware"]) {
      const res = await call((req, res) => handleCollect(req, res, deps(commands)), collectReq({ ...hit, site }));
      assert.equal(res.statusCode, 202, site);
      assert.equal(res.body, "");
    }
    const bad = await call((req, res) => handleCollect(req, res, deps(commands)), collectReq({ ...hit, site: "other" }));
    assert.equal(bad.statusCode, 400);
    assert.equal(commands.ops.filter((op) => op[0] === "HINCRBY").length, 4);
  });

  it("keeps the sister request shape and cleans the path", async () => {
    const page = readFileSync(new URL("../api/botpage.js", import.meta.url), "utf8");
    assert.match(page, /https:\/\/lowlevellibrary\.com\/api\/bot-collect\//);
    assert.match(page, /x-lll-collect-key/);
    assert.match(page, /site: SITE_ID/);
    const commands = createMemoryCommands();
    const res = await call((req, res) => handleCollect(req, res, deps(commands)), collectReq({
      site: "binrev", bot: "ClaudeBot", path: "//entries//x/?q=1", status: 404,
    }));
    assert.equal(res.statusCode, 202);
    const field = [...commands.state.hashes.values()][0];
    assert.equal([...field.keys()][0], JSON.stringify(["binrev", "ClaudeBot", "/entries/x/", 404]));
  });

  it("does not store a hit when the key, method, or body is rejected", async () => {
    const commands = createMemoryCommands();
    const run = (req) => call((rq, rs) => handleCollect(rq, rs, deps(commands)), req);
    assert.equal((await run(collectReq(hit, { "x-lll-collect-key": "nope" }))).statusCode, 401);
    assert.equal((await run({ ...collectReq(hit), method: "GET" })).statusCode, 405);
    assert.equal((await run(collectReq("{"))).statusCode, 400);
    assert.equal((await run(collectReq({ ...hit, bot: "has space" }))).statusCode, 400);
    assert.equal(commands.ops.length, 0);
  });
});

describe("aggregation, duplicates, and concurrent isolates", () => {
  it("sums duplicate and distinct events across two command handles", async () => {
    const shared = { strings: new Map(), hashes: new Map(), ops: [] };
    const a = createMemoryCommands(shared);
    const b = createMemoryCommands(shared);
    const tasks = [];
    const send = (commands, body) => {
      const res = resCapture();
      return handleCollect(collectReq(body), res, deps(commands)).then(() => res);
    };
    for (let i = 0; i < 25; i++) tasks.push(send(i % 2 ? a : b, hit));
    for (let i = 0; i < 5; i++) tasks.push(send(b, { ...hit, site: "exploit", status: 304 }));
    const results = await Promise.all(tasks);
    assert.ok(results.every((r) => r.statusCode === 202));
    const stats = await call((req, res) => handleStats(req, res, deps(a, { now: NOW })), statsReq("today"));
    assert.equal(stats.json.measured, true);
    assert.equal(stats.json.total, 30);
    assert.equal(stats.json.byBot.GPTBot, 30);
    assert.equal(stats.json.sites.main.total, 25);
    assert.equal(stats.json.sites.exploit.bots.GPTBot.pages["/courses/x/ [304]"], 5);
    assert.equal(stats.json.partialDay, true);
    assert.equal(stats.json.totalMeaning, "open_day");
    const increments = shared.ops.filter((op) => op[0] === "HINCRBY" && op[3] === "1");
    assert.equal(increments.length, 30);
    assert.equal(shared.ops.filter((op) => op[0] === "SET").length, 0);
  });
});

describe("operation budget", () => {
  it("spends two commands per accepted hit and three per stats read, with no blob list", async () => {
    const commands = createMemoryCommands();
    for (let i = 0; i < 5; i++) {
      await handleCollect(collectReq({ ...hit, path: `/${i}/` }), resCapture(), deps(commands));
    }
    await handleStats(statsReq("today"), resCapture(), deps(commands));
    const names = commands.ops.map((op) => op[0]);
    assert.deepEqual(names.filter((n) => n === "INCR"), Array(5).fill("INCR"));
    assert.equal(names.filter((n) => n === "HINCRBY").length, 5);
    assert.equal(names.filter((n) => n === "HGETALL").length, 1);
    assert.equal(names.filter((n) => n === "GET").length, 2);
    assert.equal(names.length, 5 * HIT_COMMANDS + STATS_COMMANDS);
    assert.ok(!names.includes("LIST") && !names.includes("DEL") && !names.includes("SCAN"));
    assert.equal(MAX_MONTHLY_HIT_BUDGET * HIT_COMMANDS + 60_000 <= 500_000, true);
  });

  it("stops at the shared ceiling and does not leave a zero field or keep spending", async () => {
    const commands = createMemoryCommands();
    const env = { BOT_COUNTER_MONTHLY_HIT_BUDGET: "2" };
    const send = (body) => call((req, res) => handleCollect(req, res, deps(commands, { env })), collectReq(body));
    assert.equal((await send(hit)).statusCode, 202);
    assert.equal((await send(hit)).statusCode, 202);
    const before = commands.ops.length;
    const rejected = await send({ ...hit, path: "/overflow/" });
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.json.reason, "monthly_budget");
    assert.equal(rejected.json.total, null);
    assert.equal(rejected.json.measured, false);
    assert.doesNotMatch(rejected.body, /"total":0/);
    const again = await send(hit);
    assert.equal(again.statusCode, 503);
    assert.equal(commands.ops.length, before + 5);
    const third = await send(hit);
    assert.equal(third.statusCode, 503);
    assert.equal(commands.ops.length, before + 5);
    const stats = await call((req, res) => handleStats(req, res, deps(commands, { env })), statsReq("today"));
    assert.equal(stats.json.measured, true);
    assert.equal(stats.json.total, 2);
    assert.equal(stats.json.budgetExhausted, true);
    assert.equal(stats.json.incomplete, true);
    assert.equal(commands.state.strings.get("lll:bot:v1:budget:2026-11"), 2);
    const overflow = liveKey("2026-11-10");
    const fields = commands.state.hashes.get(overflow);
    assert.equal([...fields.keys()].some((k) => k.includes("/overflow/")), false);
  });

  it("a second isolate sees the same ceiling instead of a fresh per-process cap", async () => {
    const shared = { strings: new Map(), hashes: new Map(), ops: [] };
    const first = createMemoryCommands(shared);
    const second = createMemoryCommands(shared);
    const env = { BOT_COUNTER_MONTHLY_HIT_BUDGET: "1" };
    assert.equal((await call((req, res) => handleCollect(req, res, deps(first, { env })), collectReq(hit))).statusCode, 202);
    const rejected = await call((req, res) => handleCollect(req, res, deps(second, { env })), collectReq(hit));
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.json.total, null);
    const stats = await call((req, res) => handleStats(req, res, deps(second, { env })), statsReq("today"));
    assert.equal(stats.json.total, 1);
  });
});

describe("unavailable store, quota, and honest gaps", () => {
  it("never reports a measured zero when Redis is missing or failing", async () => {
    const missing = await call((req, res) => handleCollect(req, res, deps(null)), collectReq(hit));
    assert.equal(missing.statusCode, 503);
    assert.equal(missing.json.reason, "counter_unconfigured");
    assert.equal(missing.json.total, null);
    assert.equal(missing.json.measured, false);
    assert.equal(missing.json.byBot, undefined);
    assert.doesNotMatch(missing.body, /"total":0/);

    const commands = createMemoryCommands();
    commands.pipeline = async () => { throw new CounterError("quota", "limit exceeded"); };
    const failed = await call((req, res) => handleCollect(req, res, deps(commands)), collectReq(hit));
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json.reason, "quota");
    assert.equal(failed.json.total, null);
    assert.doesNotMatch(failed.body, /"total":0/);

    const stats = await call((req, res) => handleStats(req, res, deps(commands)), statsReq("yesterday"));
    assert.equal(stats.statusCode, 503);
    assert.equal(stats.json.available, false);
    assert.equal(stats.json.measured, false);
    assert.equal(stats.json.total, null);
    assert.equal(stats.json.reason, "quota");
    assert.doesNotMatch(stats.body, /"total":0/);
  });

  it("distinguishes the preserved window, the irrecoverable gap, and a live day with no hits", async () => {
    const commands = createMemoryCommands();
    const read = (date, env = {}) => call((req, res) => handleStats(req, res, deps(commands, { env })), statsReq(date));
    const oct = await read("2026-10-24");
    assert.equal(oct.statusCode, 200);
    assert.equal(oct.json.reason, "legacy_not_imported");
    assert.equal(oct.json.total, null);
    assert.equal(oct.json.measured, false);
    assert.equal(oct.json.sites, null);
    const gap = await read("yesterday");
    assert.equal(gap.json.date, "2026-11-09");
    assert.equal(gap.json.reason, "irrecoverable_gap");
    assert.equal(gap.json.total, null);
    const today = await read("today");
    assert.equal(today.json.reason, "no_record");
    assert.equal(today.json.partialDay, true);
    assert.equal(today.json.total, null);
    const unset = await read("today", { BOT_COUNTER_LIVE_DATE: "" });
    assert.equal(unset.json.reason, "irrecoverable_gap");
    assert.equal(unset.json.total, null);
    const future = await read("2026-12-01");
    assert.equal(future.json.reason, "future");
    assert.equal(future.json.total, null);
    const early = await read("2026-10-23");
    assert.equal(early.json.reason, "before_counter");
    assert.equal(classifyUnmeasured("2026-11-06", "2026-11-10"), "legacy_not_imported");
    assert.doesNotMatch(oct.body + gap.body + today.body, /"total":0/);
  });

  it("treats a zero hash field and a corrupt hash as unknown, not as a total of zero", async () => {
    const commands = createMemoryCommands();
    const field = JSON.stringify(["main", "GPTBot", "/", 200]);
    commands.state.hashes.set(liveKey("2026-11-10"), new Map([[field, 0]]));
    const zero = await call((req, res) => handleStats(req, res, deps(commands)), statsReq("today"));
    assert.equal(zero.json.measured, false);
    assert.equal(zero.json.total, null);
    commands.state.hashes.set(liveKey("2026-11-10"), new Map([[field, -2]]));
    const negative = await call((req, res) => handleStats(req, res, deps(commands)), statsReq("today"));
    assert.equal(negative.statusCode, 503);
    assert.equal(negative.json.total, null);
    commands.state.hashes.set(liveKey("2026-11-10"), new Map([["not-json", 4]]));
    const corrupt = await call((req, res) => handleStats(req, res, deps(commands)), statsReq("today"));
    assert.equal(corrupt.statusCode, 503);
    assert.equal(corrupt.json.total, null);
    assert.equal(rowsFromHash(hashResultToObject(["ok", "1"])).ok, false);
  });
});

describe("legacy blob history", () => {
  function blob(objects) {
    const calls = [];
    return {
      calls,
      async get(pathname) {
        calls.push(["get", pathname]);
        const found = objects[pathname];
        if (!found) return { state: "absent" };
        if (found.throw) throw Object.assign(new Error("This store has been suspended."), { name: "BlobStoreSuspendedError" });
        return { state: "ok", json: found.json, uploadedAt: found.uploadedAt };
      },
      async list(prefix) {
        calls.push(["list", prefix]);
        if (objects.listThrow) throw Object.assign(new Error("This store has been suspended."), { name: "BlobStoreSuspendedError" });
        return objects.list || { state: "ok", blobs: [], truncated: false };
      },
    };
  }

  const row = (n, path = "/") => ["main", "GPTBot", path, 200, n];

  it("imports daily plus only later raw chunks, once, and does not delete blob objects", async () => {
    const commands = createMemoryCommands();
    const dailyAt = "2026-10-24T18:00:00.000Z";
    const io = blob({
      "bots/daily/2026-10-24.json": { json: { v: 1, rows: [row(10), row(1, "/a/")] }, uploadedAt: dailyAt },
      list: { state: "ok", blobs: [
        { pathname: "bots/raw/2026-10-24/old.json", uploadedAt: "2026-10-24T17:00:00.000Z" },
        { pathname: "bots/raw/2026-10-24/new.json", uploadedAt: "2026-10-24T19:00:00.000Z" },
      ] },
      "bots/raw/2026-10-24/old.json": { json: { v: 1, rows: [row(10), row(1, "/a/")] }, uploadedAt: "2026-10-24T17:00:00.000Z" },
      "bots/raw/2026-10-24/new.json": { json: { v: 1, rows: [row(4, "/new/")] }, uploadedAt: "2026-10-24T19:00:00.000Z" },
    });
    const req = {
      method: "POST",
      url: "/api/bot-admin",
      headers: { authorization: `Bearer ${ENV.BOT_STATS_TOKEN}` },
      body: { action: "import-legacy", date: "2026-10-24" },
    };
    const first = await call((r, s) => handleAdmin(r, s, deps(commands, { blobIo: io })), req);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json.wrote, true);
    assert.equal(first.json.total, 15);
    assert.equal(first.json.rawSkipped, 1);
    assert.equal(first.json.rawIncluded, 1);
    assert.equal(first.json.deletedBlobObjects, 0);
    assert.equal(first.json.blob.advancedLists, 1);
    assert.equal(first.json.incomplete, false);
    await handleCollect(collectReq(hit), resCapture(), deps(commands, { now: new Date("2026-10-24T20:00:00.000Z") }));
    const second = await call((r, s) => handleAdmin(r, s, deps(commands, { blobIo: io })), req);
    assert.equal(second.json.total, 15);
    const sets = commands.ops.filter((op) => op[0] === "SET");
    assert.equal(sets.length, 2);
    assert.equal(sets[0][2], sets[1][2]);
    const stats = await call((r, s) => handleStats(r, s, deps(commands, { now: NOW })), statsReq("2026-10-24"));
    assert.equal(stats.json.measured, true);
    assert.equal(stats.json.total, 16);
    assert.equal(stats.json.coverage, "preserved_blob_plus_redis");
    assert.equal(stats.json.sites.main.total, 16);
    assert.ok(!io.calls.some((c) => c[0] === "del"));
  });

  it("refuses an empty or conflicting legacy read and does not publish a zero", async () => {
    const commands = createMemoryCommands();
    const empty = blob({
      "bots/daily/2026-10-25.json": { json: { v: 1, rows: [] }, uploadedAt: "2026-10-25T12:00:00.000Z" },
      list: { state: "ok", blobs: [] },
    });
    const refused = await call((r, s) => handleAdmin(r, s, deps(commands, { blobIo: empty })), {
      method: "POST", url: "/api/bot-admin", headers: { authorization: `Bearer ${ENV.BOT_STATS_TOKEN}` },
      body: { action: "import-legacy", date: "2026-10-25" },
    });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json.reason, "empty_refused");
    assert.equal(refused.json.wrote, false);
    assert.equal(refused.json.total, null);
    assert.equal(commands.ops.some((op) => op[0] === "SET"), false);
    const stats = await call((r, s) => handleStats(r, s, deps(commands)), statsReq("2026-10-25"));
    assert.equal(stats.json.measured, false);
    assert.equal(stats.json.total, null);

    const acknowledged = await call((r, s) => handleAdmin(r, s, deps(commands, { blobIo: empty })), {
      method: "POST", url: "/api/bot-admin", headers: { authorization: `Bearer ${ENV.BOT_STATS_TOKEN}` },
      body: { action: "import-legacy", date: "2026-10-25", acknowledgeEmpty: true },
    });
    assert.equal(acknowledged.json.wrote, true);
    assert.equal(acknowledged.json.total, 0);
    const explicit = await call((r, s) => handleStats(r, s, deps(commands)), statsReq("2026-10-25"));
    assert.equal(explicit.json.measured, true);
    assert.equal(explicit.json.total, 0);
    assert.equal(explicit.json.totalMeaning, "explicit_empty");

    const conflictIo = blob({
      "bots/daily/2026-10-26.json": { json: { v: 1, rows: [row(2)] }, uploadedAt: "2026-10-26T12:00:00.000Z" },
      list: { state: "ok", blobs: [{ pathname: "bots/raw/2026-10-26/a.json", uploadedAt: "2026-10-26T11:00:00.000Z" }] },
      "bots/raw/2026-10-26/a.json": { json: { v: 1, rows: [row(9)] }, uploadedAt: "2026-10-26T11:00:00.000Z" },
    });
    const before = commands.ops.filter((op) => op[0] === "SET").length;
    const conflict = await call((r, s) => handleAdmin(r, s, deps(commands, { blobIo: conflictIo })), {
      method: "POST", url: "/api/bot-admin", headers: { authorization: `Bearer ${ENV.BOT_STATS_TOKEN}` },
      body: { action: "import-legacy", date: "2026-10-26" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json.reason, "legacy_conflict");
    assert.equal(conflict.json.total, null);
    assert.equal(conflict.json.dailyTotal, 2);
    assert.equal(conflict.json.olderRawTotal, 9);
    assert.equal(commands.ops.filter((op) => op[0] === "SET").length, before);
  });

  it("does not write when Blob is suspended, truncated, or outside the preserved window", async () => {
    const commands = createMemoryCommands();
    const suspended = blob({ listThrow: true, "bots/daily/2026-11-06.json": { throw: true } });
    const down = await call((r, s) => handleAdmin(r, s, deps(commands, { blobIo: suspended })), {
      method: "POST", url: "/api/bot-admin", headers: { authorization: `Bearer ${ENV.BOT_STATS_TOKEN}` },
      body: { action: "import-legacy", date: "2026-11-06" },
    });
    assert.equal(down.statusCode, 503);
    assert.equal(down.json.reason, "blob_unavailable");
    assert.equal(down.json.wrote, false);
    assert.equal(down.json.total, null);
    assert.equal(commands.ops.some((op) => op[0] === "SET"), false);
    const nov6 = await call((r, s) => handleStats(r, s, deps(commands)), statsReq("2026-11-06"));
    assert.equal(nov6.json.reason, "legacy_not_imported");
    assert.equal(nov6.json.total, null);

    const callsBefore = suspended.calls.length;
    const outside = await call((r, s) => handleAdmin(r, s, deps(commands, { blobIo: suspended })), {
      method: "POST", url: "/api/bot-admin", headers: { authorization: `Bearer ${ENV.BOT_STATS_TOKEN}` },
      body: { action: "import-legacy", date: "2026-11-07" },
    });
    assert.equal(outside.statusCode, 400);
    assert.equal(outside.json.reason, "outside_preserved_window");
    assert.equal(suspended.calls.length, callsBefore);

    const truncated = blob({ list: { state: "truncated", truncated: true, blobs: [{ pathname: "bots/raw/2026-11-05/a.json" }] } });
    const stop = await call((r, s) => handleAdmin(r, s, deps(commands, { blobIo: truncated })), {
      method: "POST", url: "/api/bot-admin", headers: { authorization: `Bearer ${ENV.BOT_STATS_TOKEN}` },
      body: { action: "import-legacy", date: "2026-11-05" },
    });
    assert.equal(stop.json.reason, "legacy_list_truncated");
    assert.equal(stop.json.wrote, false);
    assert.equal(truncated.calls.filter((c) => c[0] === "get").length, 1);
  });

  it("marks 2026-11-06 incomplete and sums only the preserved rows", async () => {
    const commands = createMemoryCommands();
    const io = blob({
      "bots/daily/2026-11-06.json": { json: { v: 1, rows: [row(7), ["firmware", "ClaudeBot", "/entries/y/", 200, 3]] }, uploadedAt: "2026-11-06T20:00:00.000Z" },
      list: { state: "ok", blobs: [] },
    });
    const imported = await call((r, s) => handleAdmin(r, s, deps(commands, { blobIo: io })), {
      method: "POST", url: "/api/bot-admin", headers: { authorization: `Bearer ${ENV.BOT_STATS_TOKEN}` },
      body: { action: "import-legacy", date: "2026-11-06" },
    });
    assert.equal(imported.json.total, 10);
    assert.equal(imported.json.incomplete, true);
    const stats = await call((r, s) => handleStats(r, s, deps(commands)), statsReq("2026-11-06"));
    assert.equal(stats.json.measured, true);
    assert.equal(stats.json.total, 10);
    assert.equal(stats.json.incomplete, true);
    assert.equal(stats.json.incompleteReason, "blob_suspended_during_day");
    assert.equal(stats.json.totalMeaning, "preserved_lower_bound");
    assert.equal(stats.json.sites.firmware.host, "firmware.lowlevellibrary.com");
  });

  it("merges raw-only days and fails closed without an uploadedAt", () => {
    const rawOnly = mergeLegacy({
      daily: null,
      raw: [{ rows: [["main", "GPTBot", "/", 200, 2]], uploadedAt: "2026-10-24T01:00:00.000Z" }, { rows: [["main", "GPTBot", "/", 200, 3]], uploadedAt: "2026-10-24T02:00:00.000Z" }],
    });
    assert.equal(rawOnly.total, 5);
    const missing = mergeLegacy({
      daily: { rows: [["main", "GPTBot", "/", 200, 2]], uploadedAt: null },
      raw: [{ rows: [["main", "GPTBot", "/", 200, 2]], uploadedAt: "2026-10-24T01:00:00.000Z" }],
    });
    assert.equal(missing.ok, false);
    const plan = planLegacyImport({ ok: false, reason: "blob_unavailable", ops: { advancedLists: 0, simpleGets: 1 } }, { date: "2026-10-24", acknowledgeEmpty: false });
    assert.equal(plan.write, false);
    assert.equal(plan.total, null);
  });
});

describe("Upstash REST integration", () => {
  function redisFetch() {
    const strings = new Map();
    const hashes = new Map();
    const calls = [];
    let failures = 0;
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (failures > 0) { failures -= 1; throw new Error("socket"); }
      const body = JSON.parse(init.body);
      const apply = (args) => {
        const [cmd, key, a, b] = args;
        if (cmd === "INCR") { const v = (strings.get(key) || 0) + 1; strings.set(key, v); return v; }
        if (cmd === "DECR") { const v = (strings.get(key) || 0) - 1; strings.set(key, v); return v; }
        if (cmd === "HINCRBY") {
          const h = hashes.get(key) || new Map();
          const v = (Number(h.get(a)) || 0) + Number(b);
          if (v === 0) h.delete(a); else h.set(a, v);
          if (h.size === 0) hashes.delete(key); else hashes.set(key, h);
          return v;
        }
        if (cmd === "HDEL") { hashes.get(key)?.delete(a); return 1; }
        if (cmd === "HGETALL") {
          const h = hashes.get(key);
          return h ? [...h].flatMap(([f, v]) => [f, String(v)]) : [];
        }
        if (cmd === "GET") return strings.has(key) ? strings.get(key) : null;
        if (cmd === "SET") { strings.set(key, a); return "OK"; }
        throw new Error(cmd);
      };
      const path = new URL(url).pathname;
      if (path === "/pipeline") return Response.json(body.map((cmd) => ({ result: apply(cmd) })));
      return Response.json({ result: apply(body) });
    };
    return { fetchImpl, calls, failNext(n) { failures = n; } };
  }

  it("sends one pipeline per accepted hit, does not retry, and keeps the token out of the URL", async () => {
    const fake = redisFetch();
    const commands = createUpstashCommands({ url: "https://example.upstash.io/ignored?_token=should-not-leak", token: "test-token-not-secret", fetchImpl: fake.fetchImpl });
    for (let i = 0; i < 4; i++) await handleCollect(collectReq(hit), resCapture(), deps(commands));
    assert.equal(fake.calls.length, 4);
    for (const call of fake.calls) {
      const url = new URL(call.url);
      assert.equal(url.pathname, "/pipeline");
      assert.equal(url.search, "");
      assert.equal(url.toString().includes("test-token-not-secret"), false);
      assert.equal(call.init.headers.authorization, "Bearer test-token-not-secret");
      assert.equal(JSON.parse(call.init.body).length, HIT_COMMANDS);
    }
    await handleStats(statsReq("today"), resCapture(), deps(commands));
    assert.equal(fake.calls.length, 5);
    assert.equal(JSON.parse(fake.calls[4].init.body).length, STATS_COMMANDS);
    const stats = await call((req, res) => handleStats(req, res, deps(commands)), statsReq("today"));
    assert.equal(stats.json.total, 4);

    fake.failNext(1);
    const before = fake.calls.length;
    const down = await call((req, res) => handleCollect(req, res, deps(commands)), collectReq(hit));
    assert.equal(down.statusCode, 503);
    assert.equal(down.json.total, null);
    assert.equal(fake.calls.length, before + 1);
  });

  it("maps a provider limit to quota and does not turn an error element into an empty day", async () => {
    const fetchImpl = async (url) => {
      if (new URL(url).pathname === "/pipeline") {
        return Response.json([{ error: "ERR max requests limit exceeded" }, { result: [] }, { result: null }]);
      }
      return Response.json({ error: "ERR max requests limit exceeded" }, { status: 429 });
    };
    const commands = createUpstashCommands({ url: "https://example.upstash.io", token: "test-token-not-secret", fetchImpl });
    const stats = await call((req, res) => handleStats(req, res, deps(commands)), statsReq("today"));
    assert.equal(stats.statusCode, 503);
    assert.equal(stats.json.reason, "quota");
    assert.equal(stats.json.total, null);
    assert.equal(stats.json.measured, false);
  });

  it("rejects a partial or non-https environment instead of writing anywhere else", () => {
    resetCommandCache();
    assert.equal(commandsFromEnv({}), null);
    assert.equal(commandsFromEnv({ UPSTASH_REDIS_REST_URL: "https://example.upstash.io" }), null);
    assert.equal(commandsFromEnv({ UPSTASH_REDIS_REST_URL: "http://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "test-token-not-secret" }), null);
    const client = commandsFromEnv({ UPSTASH_REDIS_REST_URL: "https://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "test-token-not-secret" }, async () => Response.json({ result: 1 }));
    assert.equal(commandsFromEnv({ UPSTASH_REDIS_REST_URL: "https://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "test-token-not-secret" }, async () => { throw new Error("new"); }), client);
    resetCommandCache();
  });
});

describe("admin status and blob adapter", () => {
  it("reports the budget without a total and without touching blob", async () => {
    const commands = createMemoryCommands();
    await handleCollect(collectReq(hit), resCapture(), deps(commands));
    let blobCalled = false;
    const res = await call((req, res) => handleAdmin(req, res, deps(commands, { blobIo: { get() { blobCalled = true; }, list() { blobCalled = true; } } })), {
      method: "GET", url: "/api/bot-admin", headers: { authorization: `Bearer ${ENV.BOT_STATS_TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.available, true);
    assert.equal(Object.hasOwn(res.json, "total"), false);
    assert.equal(res.json.budget.used, 1);
    assert.equal(res.json.blobProbed, false);
    assert.equal(res.json.accounting.blobAdvancedOpsPerStatsRead, 0);
    assert.equal(res.json.accounting.instanceMultiplier, 1);
    assert.equal(blobCalled, false);
    const denied = await call((req, res) => handleAdmin(req, res, deps(commands)), {
      method: "GET", url: "/api/bot-admin", headers: { authorization: "Bearer wrong-token-value" },
    });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.body, "");
  });

  it("lists a legacy prefix once and restores the SDK retry env", async () => {
    const env = { VERCEL_BLOB_RETRIES: "10" };
    let lists = 0;
    let seen;
    const io = createVercelBlobIo({
      async get() { return null; },
      async list() { lists += 1; seen = env.VERCEL_BLOB_RETRIES; return { blobs: [{ pathname: "a", uploadedAt: "2026-10-24T00:00:00.000Z" }], hasMore: true }; },
    }, env);
    const page = await io.list("bots/raw/2026-10-24/");
    assert.equal(lists, 1);
    assert.equal(seen, "0");
    assert.equal(env.VERCEL_BLOB_RETRIES, "10");
    assert.equal(page.state, "truncated");
    const absent = await io.get("bots/daily/2026-10-24.json");
    assert.equal(absent.state, "absent");
    const read = await readLegacyDate("2026-10-24", {
      async get() { return absent; },
      async list() { return page; },
    });
    assert.equal(read.ok, false);
    assert.equal(read.reason, "legacy_list_truncated");
  });
});

describe("the hot path no longer uses the blob flush", () => {
  it("collect and stats do not import blob, list, or waitUntil", () => {
    for (const file of ["api/bot-collect.js", "api/bot-stats.js"]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(src, /@vercel\/blob|waitUntil|FLUSH_DELAY|DAILY_FLUSH_CAP/);
    }
    const admin = readFileSync(new URL("../api/bot-admin.js", import.meta.url), "utf8");
    assert.doesNotMatch(admin, /import\s*\{[^}]*\bdel\b/);
    const legacy = readFileSync(new URL("../api/bot-legacy.js", import.meta.url), "utf8");
    assert.doesNotMatch(legacy, /\bdel\s*\(/);
  });
});
