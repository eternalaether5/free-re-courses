import { timingSafeEqual } from "node:crypto";

export function headerValue(headers, name) {
  const value = headers?.[name];
  return typeof value === "string" ? value : "";
}

export function secretMatch(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string" || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerOk(headers, token) {
  return secretMatch(headerValue(headers, "authorization"), token ? `Bearer ${token}` : "");
}

export function sendJson(res, status, body, { retryAfter } = {}) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (retryAfter) res.setHeader("retry-after", String(retryAfter));
  res.end(JSON.stringify(body));
}

export function unavailableBody(reason, extra = {}) {
  return { available: false, measured: false, total: null, totalMeaning: null, reason, ...extra };
}

export function logFailure(scope, error) {
  const reason = error?.reason || "counter_unavailable";
  const safe = String(error?.message || reason).replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 200);
  console.error(scope, reason, safe);
}
