// Attach a scheduled time window to a baseline that was already built.
//
// Separate from schedule-baseline.js on purpose, and it is the reason this is a script of
// its own rather than a flag. That script decides which trips were scheduled, and it is
// deliberately hard to make it change its mind: a denominator that moves after the fact is
// worthless. This one must never change that decision. It only annotates the rows that are
// already there, so it reads the baseline back out of the database and writes the same
// primary keys again. It cannot add a trip, cannot drop one, and cannot alter which feed
// decided the date.
//
// The times come from whatever static feed is on disk now, matched by trip_id, because NTA
// publishes only the current feed and no archive. For past dates that is a later feed than
// the one that built the baseline. Matching a trip_id to its timetable across a republish
// is sound; deciding whether the trip existed from a later feed is not, and this does only
// the first. Which feed supplied the times is recorded on schedule_baseline_runs so the
// difference stays visible instead of being absorbed.
//
//   node recorder/fetch-static.js --with-stop-times    # required first
//   node recorder/attach-trip-times.js                 # every date missing times
//   node recorder/attach-trip-times.js 2026-08-21
//   node recorder/attach-trip-times.js 2026-08-17 2026-08-22
//   node recorder/attach-trip-times.js 2026-08-21 --refresh   # redo dates that have them

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { requireEnv } from './env.js';
import { loadTripTimes } from './trip-times.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', 'gtfs', 'static');

const PAGE = 1000;
const BATCH = 500;

const hhmm = (s) =>
  s === null || s === undefined
    ? '--:--'
    : `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;

function feedVersion() {
  const info = fs.readFileSync(path.join(STATIC_DIR, 'feed_info.txt'), 'utf8').trim().split('\n');
  const cols = info[0].replace(/\r/g, '').split(',');
  const vals = info[1].replace(/\r/g, '').split(',');
  return vals[cols.indexOf('feed_version')] || null;
}

// Read every baseline row for a date. Paged because a national service day is ~24,800
// trips and PostgREST caps a response at 1,000.
async function readBaseline(supabase, isoDate) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('schedule_baseline')
      .select('service_date, trip_id, route_id, agency_id, route_short_name, mode, first_departure_sec, last_arrival_sec')
      .eq('service_date', isoDate)
      .order('trip_id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`reading ${isoDate}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

async function attachDate(supabase, times, timesVersion, isoDate, { refresh = false } = {}) {
  const rows = await readBaseline(supabase, isoDate);
  if (rows.length === 0) {
    console.log(`  ${isoDate}: no baseline — skipped`);
    return null;
  }

  const alreadyTimed = rows.filter((r) => r.first_departure_sec !== null).length;
  if (alreadyTimed === rows.length && !refresh) {
    console.log(`  ${isoDate}: all ${rows.length} trips already timed — pass --refresh to redo`);
    return null;
  }

  // Every row written back carries the primary key it was read with, so the upsert can
  // only ever land on a row that already exists. The non-time columns are echoed back
  // unchanged because the insert arm of the upsert has to satisfy route_id's not-null
  // constraint, not because anything about them is being revised.
  const updates = [];
  let matched = 0;
  let unmatched = 0;

  for (const r of rows) {
    const t = times.get(r.trip_id);
    if (!t) { unmatched++; continue; }
    if (r.first_departure_sec !== null && !refresh) continue;
    matched++;
    updates.push({
      service_date: r.service_date,
      trip_id: r.trip_id,
      route_id: r.route_id,
      agency_id: r.agency_id,
      route_short_name: r.route_short_name,
      mode: r.mode,
      first_departure_sec: t.first,
      last_arrival_sec: t.last,
    });
  }

  for (let i = 0; i < updates.length; i += BATCH) {
    const { error } = await supabase
      .from('schedule_baseline')
      .upsert(updates.slice(i, i + BATCH), { onConflict: 'service_date,trip_id' });
    if (error) throw new Error(`writing ${isoDate}: ${error.message}`);
  }

  // Count from the table rather than from what was just sent, so the number recorded is
  // what the database holds and not what this run believed it wrote.
  const { count: timed, error: countError } = await supabase
    .from('schedule_baseline')
    .select('trip_id', { count: 'exact', head: true })
    .eq('service_date', isoDate)
    .not('first_departure_sec', 'is', null);
  if (countError) throw new Error(`counting ${isoDate}: ${countError.message}`);

  const { error: runError } = await supabase
    .from('schedule_baseline_runs')
    .update({ times_feed_version: timesVersion, trips_with_times: timed })
    .eq('service_date', isoDate);
  if (runError) throw new Error(`recording provenance for ${isoDate}: ${runError.message}`);

  // Folded rather than spread into Math.min: a national service day is ~24,800 trips and
  // spreading an array that size into a call is close enough to V8's argument limit to be
  // a latent crash as the feed grows.
  let earliest = Infinity;
  let latest = -Infinity;
  for (const u of updates) {
    if (u.first_departure_sec < earliest) earliest = u.first_departure_sec;
    if (u.last_arrival_sec > latest) latest = u.last_arrival_sec;
  }
  const span = updates.length ? `${hhmm(earliest)}..${hhmm(latest)}` : 'n/a';

  console.log(
    `  ${isoDate}: ${timed}/${rows.length} trips timed (${matched} written, ${span})` +
    (unmatched ? `, ${unmatched} trip_ids absent from feed ${timesVersion}` : '')
  );
  return { date: isoDate, rows: rows.length, timed, unmatched };
}

// Default target: every date that has a baseline and is missing times. Explicit dates
// override, so a single date can be redone without touching the rest.
async function datesToDo(supabase, argv) {
  const args = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (args.length === 1) return args;
  if (args.length >= 2) {
    const out = [];
    const iso = (d) => d.toISOString().slice(0, 10);
    for (let d = new Date(`${args[0]}T12:00:00Z`); iso(d) <= args[1]; d.setUTCDate(d.getUTCDate() + 1)) out.push(iso(d));
    return out;
  }

  const { data, error } = await supabase
    .from('schedule_baseline_runs')
    .select('service_date, trips_with_times')
    .order('service_date');
  if (error) throw new Error(`listing baselines: ${error.message}`);
  return data.filter((r) => r.trips_with_times === null).map((r) => r.service_date);
}

async function main() {
  const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_KEY'));
  const refresh = process.argv.includes('--refresh');

  const timesVersion = feedVersion();
  console.log(`Reading stop_times.txt from feed ${timesVersion || '(unversioned)'}`);
  const { times, lines, malformed } = await loadTripTimes();
  console.log(`  ${lines.toLocaleString()} rows, ${times.size.toLocaleString()} trips` + (malformed ? `, ${malformed} unparseable` : ''));

  const dates = await datesToDo(supabase, process.argv.slice(2));
  if (dates.length === 0) {
    console.log('Every baseline already has times. Nothing to do.');
    return;
  }
  console.log(`Attaching times to ${dates.length} date(s):`);

  let done = 0;
  for (const d of dates) if (await attachDate(supabase, times, timesVersion, d, { refresh })) done++;
  if (done === 0) console.log('No dates changed.');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
