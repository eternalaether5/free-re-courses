# Bot readership counter

Bot requests are the readership of Low Level Library and its sisters. Dates are America/New_York calendar days. This counter stores those hits. It does not change the catalog, the HTML, or the crawler routes.

## What broke

`lll-bot-hits` (`store_2otqoVay2LKjXLoK`) is a private Vercel Blob store on the Hobby plan. Hobby includes 2,000 advanced Blob operations a month. Advanced operations are uploads, copies, and lists. Deletes are free. A store that crosses the allowance is suspended (`limits-exceeded-suspended`). Hobby cannot buy more operations. Rewriting the writer does not unsuspend the store: the trailing 30 days of operations have to age out, or Vercel support has to unsuspend it, and it suspends again if that window is still over 2,000. The preserved objects (reported as 231, from 2026-10-24 through 2026-11-06) stay in the store. They are not readable while it is suspended.

The old collector made that ceiling unreachable:

- Each Fluid isolate kept its own `Map` and flushed one `put` about two minutes after the first buffered hit. `maxDuration` was 300 seconds so that timer could finish. That is why writes showed up every few minutes.
- `DAILY_FLUSH_CAP` (40) lived in process memory. A new isolate, and the midnight reset inside a long-lived isolate, each got another 40 puts. Two isolates that each hit the cap cost 80 puts a day, 2,400 a month, before any stats read. The cap was not a monthly budget.
- A hit answered `202` before the flush. If the isolate died, or the put failed and the isolate then died, those hits were gone. After the store suspended, flushes failed and the buffer died with the process.
- `GET /api/bot-stats` called `list` (an advanced operation) on every read, including days that had already been compacted. `@vercel/blob` retries unknown server errors up to 10 times (`VERCEL_BLOB_RETRIES` default).
- `get` failures were swallowed. `list` failures were not, so a suspended store often surfaced as HTTP 500. When `list` returned no chunks and the daily `get` threw or missed, the handler answered HTTP 200 with `total: 0`. On a closed day, if `list` saw chunks whose bodies could not be read, it overwrote `bots/daily/<date>.json` with the short sum (`allowOverwrite: true`) and deleted the chunks. A missing read could become a stored zero. This code does not do that, and it does not delete Blob objects.

Hits from the evening of 2026-11-06 (ET) through the moment this collector is deployed with Redis configured were acknowledged into memory and never written. They cannot be reconstructed.

## What it does now

`POST /api/bot-collect/` writes one hit with two Redis commands in a single HTTP request: `INCR` of the shared monthly ceiling, then `HINCRBY` of the ET-day hash. The `202` is returned only after that write. A second isolate uses the same keys, so the cost does not multiply by the number of instances. There is no in-memory batch.

If the ceiling is already spent, the increment is undone and the handler returns 503 `monthly_budget`. An isolate that has seen the ceiling refuse further hits without more commands, so a crawl storm cannot spend four commands per rejection. The ceiling itself still lives in Redis; a new isolate checks it again. A rejected hit is not stored and is not reported as zero.

`GET /api/bot-stats` reads three keys in one pipeline (`HGETALL` of the live day, `GET` of an imported legacy day, `GET` of the monthly counter). It does not call Blob. `GET /api/bot-admin` reports the budget and does not call Blob. `POST /api/bot-admin` with `{"action":"import-legacy","date":"YYYY-MM-DD"}` is the only Blob reader. It copies one preserved day into Redis and does not delete the Blob objects.

Unknown data uses `measured: false` and `total: null`. Check `measured` before using `total`. `total || 0` and `total ?? 0` both hide an outage. The only `total: 0` this API produces is an import that was explicitly acknowledged with `"acknowledgeEmpty": true` after a preserved object really contained no rows (`totalMeaning: "explicit_empty"`).

| `reason` on an unmeasured day | Meaning |
| --- | --- |
| `before_counter` | Before 2026-10-24 |
| `legacy_not_imported` | 2026-10-24 through 2026-11-06, not imported yet |
| `irrecoverable_gap` | After 2026-11-06 and before `BOT_COUNTER_LIVE_DATE`, or the live date is unset |
| `no_record` | Live date has started and this day has no stored hits |
| `future` | After today (ET) |
| `counter_unconfigured` | Redis env is missing or not https (HTTP 503) |
| `counter_unavailable` | Redis could not be read or written (HTTP 503) |
| `quota` | The provider rejected the command (HTTP 503) |
| `monthly_budget` | The hit ceiling refused the write (HTTP 503) |

A stored day can still be `incomplete: true`. 2026-11-06 is always a lower bound (`blob_suspended_during_day`): the evening after suspension is not in the objects. A month that has used the whole hit ceiling is `monthly_budget`, because later hits were refused. An open ET day is `partialDay: true` and `totalMeaning: "open_day"`.

## Operation math

Checked against the Upstash pricing page on 2026-11-10: the Free database includes 500,000 commands a month, 250 MB, and 10 GB of bandwidth, and rejects commands past that allowance. Adding a payment method moves the database off Free onto pay-as-you-go. Do not add one. Lua and `MULTI`/`EXEC` cost extra commands, so this counter does not use them.

| Path | Commands | Blob advanced ops |
| --- | --- | --- |
| Accepted hit, any number of isolates | 2 (`INCR` + `HINCRBY`), 1 HTTP request | 0 |
| Stats read | 3, 1 HTTP request | 0 |
| Admin status | 1 `GET` | 0 |
| One legacy import | 1 `SET`, plus 1 Blob `list` and one Blob `get` per object | 1 list |

Default hit ceiling: 200,000 accepted hits a month = 400,000 commands. 60,000 commands stay reserved for reads (about 20,000 stats reads). About 40,000 commands of slack remain under 500,000. `BOT_COUNTER_MONTHLY_HIT_BUDGET` can lower this. It cannot raise it past 220,000. Storage is the number of distinct site/bot/path/status fields per day, not the number of hits. Do not enable eviction: a missing key is reported as unmeasured, which is honest, but the history would still be gone.

Two warm isolates at the old cap were already 2,400 Blob puts a month. One isolate flushing every two minutes spends 2,000 puts in about 67 hours. The new cost does not grow with isolates.

## Collection contract

Unchanged, so binrev, exploit, and firmware do not need a deploy. Each sister `botpage.js` still `POST`s to `https://lowlevellibrary.com/api/bot-collect/` with header `x-lll-collect-key` and JSON `{ "site": "binrev"|"exploit"|"firmware"|"main", "bot", "path", "status" }`. They ignore the response and abort after 2.5 seconds. `202` with an empty body means the hit is stored. `401`, `400`, and `405` are unchanged. `503` means it was not stored; the sister still serves the page.

Stats and admin use `Authorization: Bearer <BOT_STATS_TOKEN>`. Admin import is POST only, so a stats GET cannot compact or delete.

## Environment variables

Set these on the **Production** environment of the `free-re-courses` / lowlevellibrary.com project. Do not copy the Redis variables into Preview: a preview deploy would share the production counters and the monthly ceiling. One Upstash Free account can have one database.

| Name | Required | Purpose |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` | yes, for new hits | HTTPS REST endpoint of a Free Redis database |
| `UPSTASH_REDIS_REST_TOKEN` | yes, for new hits | Standard REST token. Never the read-only token |
| `BOT_COUNTER_LIVE_DATE` | yes, once Redis is live | ET calendar date of that deploy, `YYYY-MM-DD`. Until it is a real date, days after 2026-11-06 stay `irrecoverable_gap` when they have no rows |
| `BOT_COUNTER_MONTHLY_HIT_BUDGET` | no | Integer hit ceiling. Default 200000. `0` refuses new hits. Values above 220000 are clamped |
| `BOT_COLLECT_KEY` | already set | Sister and main collect header. Leave it |
| `BOT_STATS_TOKEN` | already set | Bearer token for `/api/bot-stats` and `/api/bot-admin`. Leave it |
| `BLOB_READ_WRITE_TOKEN` | already set | Used only by a manual legacy import. Leave it. Collect and stats do not read it |

No database was created from this change. Do not start an Upstash trial, do not attach a card, and do not install the Vercel Marketplace integration if that provisions a paid or pay-as-you-go database. Create one Redis database on the Free plan in the Upstash console, copy the REST URL and token, and paste them into Vercel. Confirm in the console that the database shows the Free allowance and no payment method.

## Deploy

1. Merge this branch when you want it, then deploy **Production** only. Do not start the paused routines.
2. Before the Redis variables exist, collect returns 503 and stats returns 503 `counter_unconfigured`. Pages still render. The gap keeps growing until the variables are set and Production is redeployed so the functions see them.
3. Set `BOT_COUNTER_LIVE_DATE` to the ET date of that deploy.
4. `GET /api/bot-stats?date=today` with the bearer token. The first read of a quiet day is `measured: false`, `total: null`, `reason: "no_record"`. It must not be `total: 0`.
5. One real crawler request should then make `measured: true` with a positive `total` and `partialDay: true`.
6. `GET /api/bot-admin` shows `budget.used`, the ceiling, and `blobProbed: false`. It has no `total` field.

Sister projects (`lll-binrev`, `lll-exploit`, `lll-firmware`) keep posting at the same URL. Their catalogs are untouched.

## Recovering 2026-10-24 through 2026-11-06

Do this only after Blob accepts reads again. Importing while the store is suspended returns 503 `blob_unavailable` and writes nothing.

Each date costs one advanced `list` plus one simple `get` of `bots/daily/<date>.json` and one simple `get` per raw chunk under `bots/raw/<date>/`. Fourteen dates and the reported 231 objects are about 14 advanced operations and a couple hundred simple gets, once. The SDK retry count is forced to 0 for that list so a 5xx cannot multiply it. The list stops after one page; a truncated day is not imported.

```http
POST /api/bot-admin
Authorization: Bearer <BOT_STATS_TOKEN>
Content-Type: application/json

{"action":"import-legacy","date":"2026-10-24"}
```

Repeat for each date from `2026-10-24` through `2026-11-06`. A second call with the same objects overwrites the Redis legacy key with the same rows, so it does not double count. Live hits, if any, stay in a separate key and are added at read time.

Rules:

- No daily file and no raw chunks: `no_legacy_objects`, nothing is written, stats stays `legacy_not_imported`.
- Raw chunks uploaded at or before the daily object are treated as already inside that daily file. Chunks uploaded later are added.
- If the older raw sum is greater than the daily total, the daily file is not a superset. The import returns 409 `legacy_conflict` and writes nothing. The Blob objects stay where they are.
- A preserved file whose rows sum to 0 is not imported unless the body also has `"acknowledgeEmpty": true`. That is the only way to record a measured zero, and it is labeled `explicit_empty`.
- 2026-11-06 is stored with `incomplete: true`. The number is the preserved lower bound, not the full day.
- Dates outside 2026-10-24..2026-11-06 are rejected. 2026-11-07 onward cannot be filled in.

Do not delete `lll-bot-hits`. Do not create a second Blob store to "start fresh": creation spends an advanced operation and does not contain the history. Do not turn the old compaction back on.

## What this deploy does not fix

Production is not fixed until the Free Redis database exists, the variables above are set, and Production is redeployed. Until then every hit is an honest 503 and is still lost. The Blob store stays suspended. The evening of 2026-11-06 through go-live is a permanent gap.
