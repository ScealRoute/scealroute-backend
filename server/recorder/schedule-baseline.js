// Build the schedule baseline for a service date from the static GTFS feed.
//
// This is the denominator. The recorder captures what the realtime feed asserted; this
// captures what was supposed to run, so that "did not appear" becomes measurable rather
// than assumed. Without it, the only questions answerable are about buses that did show
// up, which is exactly the bias that makes operator-reported reliability unfalsifiable.
//
// Written per date rather than as a mirror of trips.txt on purpose: NTA republishes the
// static feed continuously, and a denominator that changes after the measurement is worth
// nothing. Once a date's baseline is built it stays as it was published for that date.
//
//   node recorder/schedule-baseline.js              # yesterday and today
//   node recorder/schedule-baseline.js 2026-08-18
//   node recorder/schedule-baseline.js 2026-08-14 2026-08-19
//   node recorder/schedule-baseline.js 2026-08-18 --rebuild

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { requireEnv } from './env.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', 'gtfs', 'static');

const MODE_BY_ROUTE_TYPE = { 0: 'tram', 1: 'metro', 2: 'rail', 3: 'bus', 4: 'ferry' };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const BATCH = 1000;

function readCsv(file, onRow) {
  return new Promise((resolve, reject) => {
    const p = path.join(STATIC_DIR, file);
    if (!fs.existsSync(p)) return reject(new Error(`Missing ${file}. Run recorder/fetch-static.js first.`));
    let n = 0;
    fs.createReadStream(p).pipe(csv())
      .on('data', (row) => { onRow(row); n++; })
      .on('error', reject)
      .on('end', () => resolve(n));
  });
}

const compact = (iso) => iso.replace(/-/g, '');

/**
 * GTFS service selection: calendar.txt gives the weekly pattern within a validity window,
 * calendar_dates.txt overrides individual dates (type 1 adds, type 2 removes). The
 * overrides are what carry bank holidays, so skipping them would score a Monday timetable
 * against an August bank holiday and report a nationwide collapse in service.
 */
function activeServices({ calendar, exceptions }, isoDate) {
  const ymd = compact(isoDate);
  const dow = DAYS[new Date(`${isoDate}T12:00:00Z`).getUTCDay()];

  const active = new Set();
  for (const c of calendar) {
    if (c[dow] === '1' && c.start_date <= ymd && c.end_date >= ymd) active.add(c.service_id);
  }
  for (const e of exceptions) {
    if (e.date !== ymd) continue;
    if (e.exception_type === '1') active.add(e.service_id);
    if (e.exception_type === '2') active.delete(e.service_id);
  }
  return active;
}

async function loadFeed() {
  const calendar = [];
  const exceptions = [];
  const routes = new Map();

  await readCsv('calendar.txt', (r) => calendar.push(r));
  await readCsv('calendar_dates.txt', (r) => exceptions.push(r));
  await readCsv('routes.txt', (r) => {
    if (!r.route_id) return;
    const short = String(r.route_short_name || '').trim();
    routes.set(r.route_id, {
      agencyId: r.agency_id || null,
      shortName: short && !/^(rail|intercity)$/i.test(short) ? short : (r.route_long_name || null),
      mode: MODE_BY_ROUTE_TYPE[String(r.route_type).trim()] || null,
    });
  });

  const info = fs.readFileSync(path.join(STATIC_DIR, 'feed_info.txt'), 'utf8').trim().split('\n');
  const cols = info[0].replace(/\r/g, '').split(',');
  const vals = info[1].replace(/\r/g, '').split(',');
  const field = (name) => vals[cols.indexOf(name)] || null;
  const asDate = (ymd) => (ymd && ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null);

  return {
    calendar,
    exceptions,
    routes,
    feed: {
      version: field('feed_version'),
      startDate: asDate(field('feed_start_date')),
      endDate: asDate(field('feed_end_date')),
    },
  };
}

async function buildDate(supabase, feedData, isoDate, { rebuild = false } = {}) {
  const { routes, feed } = feedData;

  // NTA republishes the static feed continuously, and a republished feed revises the past:
  // the 2026-08-18 archive scheduled 24,412 trips for that Tuesday, and the archive
  // published at 22:18 that night scheduled 24,619 for the same day. Rebuilding from the
  // newer one would move a denominator that has already been measured against, which is
  // the one thing this table exists to prevent. A date built from a different feed version
  // is therefore left alone unless a rebuild is asked for explicitly.
  const { data: existing } = await supabase
    .from('schedule_baseline_runs')
    .select('feed_version, scheduled_trips, built_at')
    .eq('service_date', isoDate)
    .maybeSingle();

  if (existing && existing.feed_version !== feed.version && !rebuild) {
    console.log(
      `  ${isoDate}: keeping the baseline built from feed ${existing.feed_version} ` +
      `(${existing.scheduled_trips} trips); this feed is ${feed.version}. Pass --rebuild to replace it.`
    );
    return true;
  }

  // A feed cannot describe a date outside its own validity window. Building anyway would
  // silently produce a baseline for the wrong timetable, which is worse than none.
  if (feed.startDate && feed.endDate && (isoDate < feed.startDate || isoDate > feed.endDate)) {
    console.error(`  ${isoDate}: outside feed validity ${feed.startDate}..${feed.endDate} — skipped`);
    return false;
  }

  const active = activeServices(feedData, isoDate);
  if (active.size === 0) {
    console.error(`  ${isoDate}: no active services — refusing to write an empty baseline`);
    return false;
  }

  const rows = [];
  const routeIds = new Set();
  let unknownRoute = 0;

  await readCsv('trips.txt', (t) => {
    if (!t.trip_id || !t.route_id || !active.has(t.service_id)) return;
    const r = routes.get(t.route_id);
    if (!r) unknownRoute++;
    routeIds.add(t.route_id);
    rows.push({
      service_date: isoDate,
      trip_id: t.trip_id,
      route_id: t.route_id,
      agency_id: r?.agencyId ?? null,
      route_short_name: r?.shortName ?? null,
      mode: r?.mode ?? null,
    });
  });

  // Replace rather than upsert: a rebuild after a feed refresh must not leave behind trips
  // the new feed no longer schedules.
  const { error: delError } = await supabase.from('schedule_baseline').delete().eq('service_date', isoDate);
  if (delError) throw new Error(`clearing ${isoDate}: ${delError.message}`);

  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from('schedule_baseline').insert(rows.slice(i, i + BATCH));
    if (error) throw new Error(`writing ${isoDate}: ${error.message}`);
  }

  const { error: runError } = await supabase.from('schedule_baseline_runs').upsert({
    service_date: isoDate,
    feed_version: feed.version,
    feed_start_date: feed.startDate,
    feed_end_date: feed.endDate,
    scheduled_trips: rows.length,
    scheduled_routes: routeIds.size,
    built_at: new Date().toISOString(),
  });
  if (runError) throw new Error(`recording run for ${isoDate}: ${runError.message}`);

  console.log(
    `  ${isoDate}: ${rows.length} trips, ${routeIds.size} routes, ${active.size} services` +
    (unknownRoute ? ` (${unknownRoute} trips on routes absent from routes.txt)` : '')
  );
  return true;
}

function datesFromArgs(argv) {
  const args = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const iso = (d) => d.toISOString().slice(0, 10);

  if (args.length === 0) {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    return [iso(yesterday), iso(today)];
  }
  if (args.length === 1) return args;

  const out = [];
  for (let d = new Date(`${args[0]}T12:00:00Z`); iso(d) <= args[1]; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(iso(d));
  }
  return out;
}

async function main() {
  const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_KEY'));
  const dates = datesFromArgs(process.argv.slice(2));

  const rebuild = process.argv.includes('--rebuild');
  const feedData = await loadFeed();
  console.log(`Static feed ${feedData.feed.version || '(unversioned)'}, valid ${feedData.feed.startDate}..${feedData.feed.endDate}`);
  console.log(`Building baseline for ${dates.length} date(s)${rebuild ? ', replacing any existing baseline' : ''}:`);

  let built = 0;
  for (const d of dates) if (await buildDate(supabase, feedData, d, { rebuild })) built++;

  if (built === 0) {
    console.error('No baselines written.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
