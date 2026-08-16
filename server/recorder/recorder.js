// Route health recorder.
//
// Polls the TFI GTFS-Realtime TripUpdates feed on a timer and persists what it saw.
// GTFS-RT is live-only with no historical archive, so an hour not recorded is an hour
// that can never be recovered. Everything here is built around not losing data:
// in-memory accumulation, periodic batched flushes, and a flush on shutdown.
//
// RATE LIMIT: the TFI quota is 3 requests/minute, pooled across every GTFS-RT endpoint
// on the key. This process must therefore be the only thing polling that key. Running it
// alongside the API server's own refreshFeeds() will put both permanently over budget.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadStatic } from './static.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const ONCE = process.argv.includes('--once');

// 3 req/min quota. 25s leaves headroom for a retry without tipping over the limit.
const POLL_INTERVAL_MS = Number(process.env.RECORDER_POLL_MS || 25_000);
const FLUSH_INTERVAL_MS = Number(process.env.RECORDER_FLUSH_MS || 120_000);
const BATCH_SIZE = 500;

const TRIP_UPDATES_URL =
  process.env.TFI_TRIP_UPDATES_URL || 'https://api.nationaltransport.ie/gtfsr/v2/TripUpdates';

let supabase = null;
if (!DRY_RUN) {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_KEY. Use --dry-run to test without a database.');
    process.exit(1);
  }
  supabase = createClient(SUPABASE_URL.trim(), SUPABASE_KEY.trim());
}

// --- in-memory accumulators, keyed so that repeated observations merge rather than duplicate
const stopObs = new Map();   // `${serviceDate}|${tripId}|${stopId}` -> row
const tripObs = new Map();   // `${serviceDate}|${tripId}`           -> row
const pendingPolls = [];
const dirtyStops = new Set();
const dirtyTrips = new Set();

const stats = { polls: 0, ok: 0, rateLimited: 0, failed: 0, flushed: 0, flushErrors: 0 };

/**
 * Service date, not calendar date. Transit days run past midnight: a 00:40 departure
 * belongs to the previous day's service. Rolling over at 04:00 local keeps a night trip
 * grouped with the day it was scheduled under.
 */
function serviceDateFor(date = new Date()) {
  const d = new Date(date);
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function toMillis(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v * 1000;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber() * 1000;
  if (typeof v === 'object' && v.low !== undefined) {
    return (v.low >>> 0) * 1000 + (v.high || 0) * 4294967296000;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : null;
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

async function pollOnce(resolveRoute) {
  const startedAt = Date.now();
  const poll = { feed: 'trip_updates', polled_at: new Date().toISOString() };
  stats.polls++;

  let res;
  try {
    res = await fetch(TRIP_UPDATES_URL, { headers: { 'x-api-key': process.env.TFI_API_KEY } });
  } catch (err) {
    stats.failed++;
    pendingPolls.push({ ...poll, http_status: 0, ok: false, duration_ms: Date.now() - startedAt, error: err.message });
    console.warn(`network error: ${err.message}`);
    return;
  }

  poll.http_status = res.status;
  poll.ok = res.ok;
  poll.duration_ms = Date.now() - startedAt;

  if (!res.ok) {
    if (res.status === 429) stats.rateLimited++; else stats.failed++;
    pendingPolls.push({ ...poll, error: res.status === 429 ? 'rate limited' : `HTTP ${res.status}` });
    console.warn(`HTTP ${res.status}${res.status === 429 ? ' (rate limited, backing off to next tick)' : ''}`);
    return;
  }

  const buf = await res.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buf));

  const now = new Date().toISOString();
  const feedTsMs = toMillis(feed.header?.timestamp);
  const serviceDate = serviceDateFor();

  let entities = 0;
  let stopUpdates = 0;

  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu?.trip) continue;
    entities++;

    const tripId = tu.trip.tripId;
    if (!tripId) continue; // ~1% of entities; nothing to key on, so not recordable

    const routeId = tu.trip.routeId || null;
    const { shortName: routeShortName, mode } = resolveRoute(routeId);
    const sr = tu.trip.scheduleRelationship ?? null;

    const tKey = `${serviceDate}|${tripId}`;
    let trip = tripObs.get(tKey);
    if (!trip) {
      trip = {
        service_date: serviceDate,
        trip_id: tripId,
        route_id: routeId,
        route_short_name: routeShortName,
        mode,
        schedule_relationship: sr,
        first_seen_at: now,
        last_seen_at: now,
        poll_count: 0,
        max_stop_sequence: null,
      };
      tripObs.set(tKey, trip);
    }
    trip.last_seen_at = now;
    trip.poll_count++;
    if (sr !== null) trip.schedule_relationship = sr;
    dirtyTrips.add(tKey);

    for (const su of tu.stopTimeUpdate || []) {
      const stopId = su.stopId;
      if (!stopId) continue;
      stopUpdates++;

      const predictedMs = toMillis(su.arrival?.time) ?? toMillis(su.departure?.time);
      const delayRaw = su.arrival?.delay ?? su.departure?.delay ?? null;
      const delay = delayRaw === null || delayRaw === undefined ? null : Number(delayRaw);
      const seq = su.stopSequence ?? null;

      if (seq !== null && (trip.max_stop_sequence === null || seq > trip.max_stop_sequence)) {
        trip.max_stop_sequence = seq;
      }

      const key = `${serviceDate}|${tripId}|${stopId}`;
      let row = stopObs.get(key);
      if (!row) {
        row = {
          service_date: serviceDate,
          trip_id: tripId,
          stop_id: stopId,
          route_id: routeId,
          route_short_name: routeShortName,
          mode,
          stop_sequence: seq,
          schedule_relationship: sr,
          first_seen_at: now,
          last_seen_at: now,
          observation_count: 0,
          first_predicted_time: iso(predictedMs),
          last_predicted_time: iso(predictedMs),
          first_delay_seconds: delay,
          last_delay_seconds: delay,
        };
        stopObs.set(key, row);
      }
      row.last_seen_at = now;
      row.observation_count++;
      if (predictedMs !== null) row.last_predicted_time = iso(predictedMs);
      if (delay !== null) {
        row.last_delay_seconds = delay;
        if (row.first_delay_seconds === null) row.first_delay_seconds = delay;
      }
      dirtyStops.add(key);
    }
  }

  poll.feed_timestamp = iso(feedTsMs);
  poll.entity_count = entities;
  poll.stop_update_count = stopUpdates;
  pendingPolls.push(poll);
  stats.ok++;

  const age = feedTsMs ? Math.round((Date.now() - feedTsMs) / 1000) : '?';
  console.log(
    `poll ${stats.polls}: ${entities} trips, ${stopUpdates} stop updates, feed age ${age}s ` +
    `| tracking ${stopObs.size} stop events across ${tripObs.size} trips`
  );
}

async function flush() {
  if (DRY_RUN) {
    console.log(`[dry-run] would flush ${dirtyStops.size} stop rows, ${dirtyTrips.size} trip rows, ${pendingPolls.length} poll rows`);
    dirtyStops.clear();
    dirtyTrips.clear();
    pendingPolls.length = 0;
    return;
  }

  const stopRows = [...dirtyStops].map((k) => stopObs.get(k)).filter(Boolean);
  const tripRows = [...dirtyTrips].map((k) => tripObs.get(k)).filter(Boolean);
  const pollRows = pendingPolls.splice(0, pendingPolls.length);

  // Clear the dirty sets up front: rows are still in the maps, so anything that fails
  // here gets picked up by the next flush once it is touched again.
  dirtyStops.clear();
  dirtyTrips.clear();

  const jobs = [
    ['stop_observations', stopRows, 'service_date,trip_id,stop_id'],
    ['trip_presence', tripRows, 'service_date,trip_id'],
  ];

  for (const [table, rows, onConflict] of jobs) {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from(table).upsert(batch, { onConflict });
      if (error) {
        stats.flushErrors++;
        console.error(`flush error on ${table}: ${error.message}`);
      } else {
        stats.flushed += batch.length;
      }
    }
  }

  if (pollRows.length) {
    const { error } = await supabase.from('feed_polls').insert(pollRows);
    if (error) console.error(`flush error on feed_polls: ${error.message}`);
  }

  console.log(`flushed ${stopRows.length} stop rows, ${tripRows.length} trip rows, ${pollRows.length} poll rows`);
}

/** Drop the previous service day from memory once we are safely into the next one. */
function pruneOldServiceDays() {
  const today = serviceDateFor();
  let dropped = 0;
  for (const key of stopObs.keys()) {
    if (!key.startsWith(`${today}|`)) { stopObs.delete(key); dropped++; }
  }
  for (const key of tripObs.keys()) {
    if (!key.startsWith(`${today}|`)) tripObs.delete(key);
  }
  if (dropped) console.log(`pruned ${dropped} stop events from previous service days`);
}

async function main() {
  console.log(`ScealRoute route health recorder${DRY_RUN ? ' [DRY RUN, no database writes]' : ''}`);

  const { routeCount, resolveRoute } = await loadStatic();
  console.log(`loaded ${routeCount} routes for short-name resolution`);
  console.log(`polling every ${POLL_INTERVAL_MS / 1000}s, flushing every ${FLUSH_INTERVAL_MS / 1000}s`);

  await pollOnce(resolveRoute);

  if (ONCE) {
    await flush();
    console.log('single poll complete', stats);
    return;
  }

  const pollTimer = setInterval(() => {
    pollOnce(resolveRoute).catch((e) => console.error('poll failed:', e.message));
  }, POLL_INTERVAL_MS);

  const flushTimer = setInterval(() => {
    flush().catch((e) => console.error('flush failed:', e.message));
    pruneOldServiceDays();
  }, FLUSH_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${sig} received, flushing before exit...`);
    clearInterval(pollTimer);
    clearInterval(flushTimer);
    try { await flush(); } catch (e) { console.error('final flush failed:', e.message); }
    console.log('recorder stopped', stats);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => { console.error(e); process.exit(1); });
