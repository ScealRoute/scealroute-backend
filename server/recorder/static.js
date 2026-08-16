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

export function makeRouteResolver(shortNames) {
  return function resolveRoute(rawRouteId) {
    if (!rawRouteId) return { shortName: null, mode: null };
    const raw = String(rawRouteId).trim();

    // Rail: strip the trailing direction marker, keep the origin-destination pair.
    if (RAIL_ID.test(raw)) {
      return { shortName: raw.replace(/-[IO]$/, ''), mode: 'rail' };
    }

    const tokens = raw.split(/[\s\-_]+/).filter(Boolean);

    // A token that is exactly a known route short name wins outright.
    for (const t of tokens) {
      const up = t.toUpperCase();
      if (shortNames.has(up)) return { shortName: up, mode: 'bus' };
    }

    // Otherwise accept a bus-route-shaped token: digits with an optional trailing letter.
    const shaped = tokens.find((t) => /^\d{1,4}[A-Za-z]?$/.test(t));
    return shaped ? { shortName: shaped.toUpperCase(), mode: 'bus' } : { shortName: null, mode: null };
  };
}

export async function loadStatic() {
  const routeShortNames = new Set();
  const routesById = new Map();

  const routeCount = await readCsv('routes.txt', (r) => {
    if (!r.route_id) return;
    routesById.set(r.route_id, r.route_short_name || null);
    // "rail" and "InterCity" are placeholders in the NTA feed, not route identifiers,
    // so they must not enter the match set or every train resolves to the same route.
    const short = String(r.route_short_name || '').trim();
    if (short && !/^(rail|intercity)$/i.test(short)) {
      routeShortNames.add(short.toUpperCase());
    }
  });

  return {
    routeCount,
    routesById,
    routeShortNames,
    resolveRoute: makeRouteResolver(routeShortNames),
  };
}
