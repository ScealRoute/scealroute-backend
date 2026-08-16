// Static GTFS lookups.
//
// Against a CURRENT feed these are exact joins, not guesses: the realtime feed's routeId
// matches routes.txt route_id (98.1% of live trips) and its tripId matches trips.txt
// trip_id (100%). Route names, modes and destinations are therefore looked up, not parsed.
//
// That was not true of the December 2025 feed previously committed to this repo, where
// both joins were 0% because the identifier space had rolled over. If these hit rates
// collapse, the static feed is stale: run recorder/fetch-static.js.
//
// stop_times.txt is not loaded. It is 525 MB and nothing needs it yet; the realtime feed
// reports `delay` directly, so punctuality is measured without scheduled times.

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', 'gtfs', 'static');

// GTFS route_type: 0 tram, 2 rail, 3 bus.
const MODE_BY_ROUTE_TYPE = { 0: 'tram', 1: 'metro', 2: 'rail', 3: 'bus', 4: 'ferry' };

// Rail services appear in the realtime feed as ORIGIN-DEST-direction, e.g. "DUB-CORK-O".
const RAIL_ID = /^[A-Z][A-Z/.]*(-[A-Z][A-Z/.]*)+-[IO]$/;

function readCsv(file, onRow) {
  return new Promise((resolve, reject) => {
    const p = path.join(STATIC_DIR, file);
    if (!fs.existsSync(p)) return resolve(0);
    let n = 0;
    fs.createReadStream(p)
      .pipe(csv())
      .on('data', (row) => { onRow(row); n++; })
      .on('error', reject)
      .on('end', () => resolve(n));
  });
}

/**
 * Fallback only, for the ~2% of realtime routeIds with no match in routes.txt.
 * The space-delimited form leads with an operator token, not the route: "2 64 d a" is
 * route 64 operated by 2. Taking the first route-shaped token yields the operator for
 * every service and silently merges hundreds of routes, so the leading token is dropped.
 *
 * Returns null rather than guessing wildly, because a misattributed observation corrupts
 * another route's statistics, which is the one failure this dataset cannot survive.
 */
function parseRouteName(raw) {
  if (RAIL_ID.test(raw)) return { shortName: raw.replace(/-[IO]$/, ''), mode: 'rail' };
  const tokens = raw.split(/\s+/).filter(Boolean);
  const body = tokens.length >= 2 ? tokens.slice(1) : tokens;
  const shaped = body.find((t) => /^\d{1,4}[A-Za-z]?$/.test(t));
  return shaped ? { shortName: shaped.toUpperCase(), mode: null } : { shortName: null, mode: null };
}

/**
 * @param {object} opts
 * @param {boolean} opts.withTrips  Load trips.txt (314k rows, ~25 MB) for trip->route and
 *   headsign lookups. The recorder does not need it; the API does, for destinations.
 */
export async function loadStatic({ withTrips = false } = {}) {
  const routes = new Map();      // route_id -> { shortName, longName, mode }
  const tripToRoute = new Map(); // trip_id  -> route_id
  const headsigns = new Map();   // trip_id  -> trip_headsign

  const routeCount = await readCsv('routes.txt', (r) => {
    if (!r.route_id) return;
    const short = String(r.route_short_name || '').trim();
    routes.set(r.route_id, {
      // "rail" and "InterCity" are placeholders in this feed, not identifiers, so a route
      // carrying one gets its long name instead ("Dublin - Cork").
      shortName: short && !/^(rail|intercity)$/i.test(short) ? short : (r.route_long_name || null),
      longName: r.route_long_name || null,
      mode: MODE_BY_ROUTE_TYPE[String(r.route_type).trim()] || null,
    });
  });

  let tripCount = 0;
  if (withTrips) {
    tripCount = await readCsv('trips.txt', (t) => {
      if (!t.trip_id) return;
      if (t.route_id) tripToRoute.set(t.trip_id, t.route_id);
      if (t.trip_headsign) headsigns.set(t.trip_id, t.trip_headsign);
    });
  }

  /** Exact lookup first; parse only when the feed offers a route this static feed lacks. */
  function resolveRoute(rawRouteId, tripId) {
    if (!rawRouteId && !tripId) return { shortName: null, mode: null, matched: false };

    let entry = rawRouteId ? routes.get(rawRouteId) : null;

    // Some realtime entities carry a tripId we can resolve even when the routeId is unknown.
    if (!entry && tripId && tripToRoute.has(tripId)) {
      entry = routes.get(tripToRoute.get(tripId));
    }

    if (entry) return { shortName: entry.shortName, mode: entry.mode, matched: true };

    const parsed = parseRouteName(String(rawRouteId || '').trim());
    return { ...parsed, matched: false };
  }

  const headsignFor = (tripId) => (tripId ? headsigns.get(tripId) || null : null);

  return { routeCount, tripCount, routes, tripToRoute, headsigns, resolveRoute, headsignFor };
}
