# Route health recorder

Captures what the TFI GTFS-Realtime feed asserted, continuously, so route reliability can
be computed from it later.

**The feed is live-only. There is no historical archive and no way to backfill.** An hour
not recorded is an hour of route health that can never be computed. That is the entire
reason this runs as its own long-lived process rather than as part of the API.

## Rate limit

The TFI quota is **3 requests per minute, pooled across every GTFS-RT endpoint on the key**
(measured, not documented). The recorder polls TripUpdates every 25 seconds, which is about
2.4 requests per minute and leaves headroom for a retry.

This process must be the **only** thing polling that key. The API server's `refreshFeeds()`
spends 4 requests per minute on its own, so running both against one key puts both
permanently over budget and neither gets data. Either disable `refreshFeeds()` and have the
API read from these tables, or obtain a second key.

## Setup

Database (already applied to the ScealRoute project; migrations live in `supabase/migrations/`):

```bash
supabase db push --linked
```

Static GTFS feed, required before first run and periodically thereafter:

```bash
node recorder/fetch-static.js                    # ~25 MB kept out of a 187 MB archive
node recorder/fetch-static.js --with-stop-times  # adds the 525 MB timetable
```

**The static feed is not committed and must not be.** NTA republishes it regularly. The
December 2025 snapshot that used to live in this repo had drifted so far by August 2026
that its identifiers no longer matched the realtime feed at all: `trip_id` joined at 0%,
`route_id` not at all. Route names had to be guessed and destinations were unavailable.
Against a current feed both joins are exact.

## Running

```bash
node recorder/recorder.js                 # poll and persist, runs until stopped
node recorder/recorder.js --dry-run       # no database writes, prints what it would do
node recorder/recorder.js --once          # single poll, then exit
node recorder/recorder.js --dry-run --once
```

Environment (read from `server/.env`): `TFI_API_KEY`, `TFI_TRIP_UPDATES_URL`,
`SUPABASE_URL`, `SUPABASE_KEY`. Optional: `RECORDER_POLL_MS` (default 25000),
`RECORDER_FLUSH_MS` (default 120000).

It flushes on SIGINT and SIGTERM, so a normal restart loses nothing.

## What it records

| Table | Grain | Purpose |
|---|---|---|
| `feed_polls` | one row per poll | Provenance. Distinguishes "the bus did not run" from "we were not watching". |
| `stop_observations` | one row per trip + stop + service date | The measurement. Delay, prediction drift, first and last seen. |
| `trip_presence` | one row per trip + service date | Cheap presence and cancellation tracking. |
| `route_health_daily` | one row per route + service date | Nightly rollup. The publishable asset. |

Roughly 500k stop observation rows per day nationally. Partition or apply the retention
window in `schema.sql` once a comfortable history exists; the rollup is the durable part
and raw rows exist so it can be recomputed.

### Write volume

Row count is not the same as write volume. Around 13,000 stop events are in flight at any
moment, and a naive recorder would rewrite all of them on every flush.

Measured against the live feed: **about 97% of stop events are identical between
consecutive polls.** Only 3% change delay or predicted time, plus roughly 200 genuinely new
events per 30 seconds. So the recorder marks a row dirty only when something meaningful
changed.

Observed effect in a live soak: the first flush after startup writes everything (11,686
rows, correctly, since it is all new), and the next steady-state flush writes **777 rows
instead of 11,920**. Trip rows drop from 2,011 to 6.

`last_seen_at` still needs to be reasonably fresh, because a trip's disappearance from the
feed is the signal a non-appearance is derived from. `RECORDER_CHECKPOINT_MS` (default 15
minutes) bounds how stale it can get: any row untouched for longer is rewritten even if
nothing changed.

## Design notes

**`stop_times.txt` is deliberately not loaded.** It is 536 MB and 10.2M rows, and it is not
needed: the realtime feed reports `delay` directly on about 88% of stop updates, so
punctuality is measured without joining to scheduled times.

**Bus and rail are recorded separately** via the `mode` column and never blended into one
score. They have different operators, schedules and tolerances for lateness.

**Route names are looked up, not parsed.** Against a current static feed the realtime
`routeId` matches `routes.txt` at 98.1% and `tripId` matches `trips.txt` at 100%, so names,
modes and destinations are exact joins. A parser survives only as a fallback for the ~2%
with no match, and it returns null rather than guessing wildly, because a misattributed
observation silently corrupts another route's statistics.

The recorder logs a count of unmatched route ids each poll. **A growing count means the
static feed has gone stale**; run `fetch-static.js`.

**Collection stores signal, the rollup stores opinion.** Thresholds for "on time" live in
`rollup.sql` and can be changed and re-run over the raw data. Nothing interpretive is baked
into collection, because collection cannot be repeated.

## Publishing

`route_health_public` enforces two rules that keep a published figure defensible:

- the denominator travels with the score, since sample size is the first thing an operator
  will dispute
- routes with fewer than 50 measured stop events return `null` rather than a percentage

Do not publish a score without its sample size.
