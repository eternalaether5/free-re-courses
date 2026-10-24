// Bots only: vercel.json routes requests whose User-Agent looks like a crawler here.
// Humans never reach this function; they get the static CDN file directly.
// This proxies the identical static page (same status, headers, body) and reports
// {site, bot name, path, status} to the central counter. No IP or UA string is stored.
import { botName, cleanPath } from "./_bots.js";

const SITE_ID = "main";
const ORIGIN = "https://lowlevellibrary.com";
const COLLECT_URL = "https://lowlevellibrary.com/api/bot-collect/";
const PROXY_UA = "LLL-static-proxy/1.0 (+https://lowlevellibrary.com/)";
const DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function report(bot, path, status) {
  const key = process.env.BOT_COLLECT_KEY;
  if (!key || !bot) return Promise.resolve();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 2500);
  return fetch(COLLECT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lll-collect-key": key, "user-agent": PROXY_UA },
    body: JSON.stringify({ site: SITE_ID, bot, path, status }),
    signal: ac.signal,
  }).catch(() => {}).finally(() => clearTimeout(t));
}

export default async function handler(req, res) {
  const url = new URL(req.url, ORIGIN);
  const path = cleanPath(url.searchParams.get("__p") || "/");
  url.searchParams.delete("__p");
  const qs = url.searchParams.toString();
  const target = ORIGIN + path + (qs ? "?" + qs : "");
  const bot = botName(req.headers["user-agent"]) || "other-bot";
  const method = req.method === "HEAD" ? "HEAD" : "GET";

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      redirect: "manual",
      headers: {
        "user-agent": PROXY_UA,
        "x-lll-proxy": "1",
        accept: req.headers["accept"] || "*/*",
        ...(req.headers["accept-language"] ? { "accept-language": req.headers["accept-language"] } : {}),
        ...(req.headers["if-none-match"] ? { "if-none-match": req.headers["if-none-match"] } : {}),
        ...(req.headers["if-modified-since"] ? { "if-modified-since": req.headers["if-modified-since"] } : {}),
      },
    });
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("retry-after", "60");
    return res.end("Temporary upstream error");
  }

  const rep = report(bot, path, upstream.status);
  res.statusCode = upstream.status;
  upstream.headers.forEach((v, k) => {
    if (DROP.has(k) || k.startsWith("x-vercel-") || k === "set-cookie") return;
    res.setHeader(k, v);
  });
  res.setHeader("vercel-cdn-cache-control", "no-store");
  const body = method === "HEAD" ? null : Buffer.from(await upstream.arrayBuffer());
  await rep;
  return res.end(body);
}
