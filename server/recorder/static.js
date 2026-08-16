// Static GTFS lookups needed by the recorder.
//
// Deliberately does NOT load stop_times.txt. That file is 536 MB / 10.2M rows, and the
// recorder does not need it: the realtime feed reports `delay` directly on ~88% of stop
// updates, so punctuality is measured without joining to scheduled times. Keeping this
// out is the difference between a process that starts in two seconds and one that needs
// gigabytes of heap.

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', 'gtfs', 'static');

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
 * The realtime feed's routeId is not the static route_id. Observed live formats:
 *   "2 245 c a"      bus: space-delimited, the route number is the numeric token
 *   "DUB-CORK-O"     rail: ORIGIN-DEST-direction, no numeric token at all
 *   "BRAY-HOWTH-I"   rail: DART
 * Static route_id looks like "5146_116052", which the feed never uses.
 *
 * Rail is resolved from the feed id rather than the static feed on purpose: the static
 * route_short_name for every intercity service is the literal string "rail" or
 * "InterCity", which is useless as an identifier. "DUB-CORK" is the better name and the
 * feed already gives it to us.
 *
 * Mode is carried alongside because blending bus and rail punctuality into a single
 * route health figure would not be meaningful. They have different schedules, different
 * operators and different tolerances for what counts as late.
 *
 * Returning null is preferable to guessing: a misattributed observation silently
 * corrupts another route's statistics, which is the one failure this data cannot survive.
 */
const RAIL_ID = /^[A-Z][A-Z/.]*(-[A-Z][A-Z/.]*)+-[IO]$/;

/**
 * IMPORTANT: the returned short name is a best-effort *label*, not an identity.
 * Observations are grouped by the raw feed routeId, which is always present and always
 * stable. Naming is interpretation and belongs in the rollup, where it can be recomputed.
 *
 * Why not join trip_id against the static feed, which would be authoritative? Because it
 * currently joins at 0%. The committed static GTFS is the December 2025 snapshot and its
 * trip ids (`5146_1001`) are completely disjoint from what the live feed now emits
 * (`5850_35137`). Refreshing the static feed is a prerequisite for authoritative naming.
 *
 * The space-delimited bus format leads with an operator token, not the route:
 *   "2 64 d a"    -> 64,  not 2
 *   "2 109A c b"  -> 109A
 * Taking the first route-shaped token returns the operator code for every service, which
 * silently collapses hundreds of distinct routes into "1", "2" and "3". Found by reading
 * real rows back out of the database.
 */
// GTFS route_type: 0 tram, 2 rail, 3 bus.
const MODE_BY_ROUTE_TYPE = { 0: 'tram', 2: 'rail', 3: 'bus' };

export function makeRouteResolver(shortNames, modeByShortName = new Map()) {
  return function resolveRoute(rawRouteId) {
    if (!rawRouteId) return { shortName: null, mode: null };
    const raw = String(rawRouteId).trim();

    // Rail: strip the trailing direction marker, keep the origin-destination pair.
    if (RAIL_ID.test(raw)) {
      return { shortName: raw.replace(/-[IO]$/, ''), mode: 'rail' };
    }

    const tokens = raw.split(/\s+/).filter(Boolean);
    // Drop the leading operator token before looking for the route.
    const body = tokens.length >= 2 ? tokens.slice(1) : tokens;

    // A token that is exactly a known route short name wins outright. Mode comes from that
    // route's GTFS route_type rather than being assumed: "10000 GREEN g a" is the LUAS
    // Green Line, and scoring a tram as a bus produced a nonsensical 35-minutes-early
    // median before this was caught.
    for (const t of body) {
      const up = t.toUpperCase();
      if (shortNames.has(up)) return { shortName: up, mode: modeByShortName.get(up) || 'bus' };
    }

    // Otherwise accept a bus-route-shaped token: digits with an optional trailing letter.
    const shaped = body.find((t) => /^\d{1,4}[A-Za-z]?$/.test(t));
    if (!shaped) return { shortName: null, mode: null };
    const up = shaped.toUpperCase();
    return { shortName: up, mode: modeByShortName.get(up) || 'bus' };
  };
}

export async function loadStatic() {
  const routeShortNames = new Set();
  const routesById = new Map();
  const modeByShortName = new Map();

  const routeCount = await readCsv('routes.txt', (r) => {
    if (!r.route_id) return;
    routesById.set(r.route_id, r.route_short_name || null);
    // "rail" and "InterCity" are placeholders in the NTA feed, not route identifiers,
    // so they must not enter the match set or every train resolves to the same route.
    const short = String(r.route_short_name || '').trim();
    if (short && !/^(rail|intercity)$/i.test(short)) {
      const up = short.toUpperCase();
      routeShortNames.add(up);
      const mode = MODE_BY_ROUTE_TYPE[String(r.route_type).trim()];
      if (mode) modeByShortName.set(up, mode);
    }
  });

  return {
    routeCount,
    routesById,
    routeShortNames,
    modeByShortName,
    resolveRoute: makeRouteResolver(routeShortNames, modeByShortName),
  };
}
