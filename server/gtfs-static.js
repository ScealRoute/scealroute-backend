// gtfs-static.js
// Loads TFI static GTFS into a local SQLite database and provides helpers
// like getStopsNearby.

import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// The 'gtfs' library is CommonJS, so we bridge it with createRequire
const require = createRequire(import.meta.url);
const { importGtfs, openDb } = require('gtfs');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Where we store the GTFS SQLite DB
const SQLITE_PATH = path.join(__dirname, 'gtfs.sqlite');
// Where your static.zip lives
const STATIC_ZIP = path.join(__dirname, 'data', 'static.zip');

let gtfsDb;          // handle for the 'gtfs' library DB
let rawDb;           // direct better-sqlite3 handle for fast queries

// Call this once at server startup
export async function ensureStaticLoaded() {
  if (!fs.existsSync(STATIC_ZIP)) {
    throw new Error(`Static GTFS zip not found at ${STATIC_ZIP}. Make sure data/static.zip exists.`);
  }

  // Import the GTFS zip into gtfs.sqlite (this can take a bit on first run)
  await importGtfs({
    agencies: [{ path: STATIC_ZIP }],
    sqlitePath: SQLITE_PATH
  });

  // gtfsDb is used by the 'gtfs' helper if needed
  gtfsDb = await openDb({ sqlitePath: SQLITE_PATH });

  // rawDb is used for our own SQL queries
  rawDb = new Database(SQLITE_PATH);

  console.log('GTFS static data loaded into', SQLITE_PATH);
}

// Helper: simple distance in metres (Haversine)
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.asin(Math.sqrt(a));
  return R * c;
}

// This is what /stops/nearby will use
export function getStopsNearby(lat, lon, radiusMeters = 500) {
  if (!rawDb) {
    throw new Error('GTFS DB not initialised yet – did you call ensureStaticLoaded()?');
  }

  // Grab all stops from the GTFS DB
  const rows = rawDb
    .prepare('SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops')
    .all();

  // Compute distance and filter within radius
  const nearby = rows
    .map(r => ({
      ...r,
      distance: haversine(lat, lon, r.stop_lat, r.stop_lon)
    }))
    .filter(r => r.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance);

  // For now just return them as-is
  return nearby;
}
