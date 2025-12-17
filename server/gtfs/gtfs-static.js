// gtfs-static.js – safely isolated GTFS loader
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { importGtfs, openDb } = require('gtfs');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SQLITE_PATH = path.join(__dirname, 'gtfs.sqlite');
const STATIC_ZIP = path.join(__dirname, 'static.zip');

let rawDb = null;

// Load GTFS static.zip → SQLite DB
export async function loadStaticGTFS() {
  if (!fs.existsSync(STATIC_ZIP)) {
    throw new Error(`GTFS static.zip not found at ${STATIC_ZIP}`);
  }

  await importGtfs({
    agencies: [{ path: STATIC_ZIP }],
    sqlitePath: SQLITE_PATH
  });

  rawDb = new Database(SQLITE_PATH);
  console.log("GTFS static loaded:", SQLITE_PATH);
}

// Haversine formula (meters)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return R * 2 * Math.asin(Math.sqrt(a));
}

// Query real stops by radius
export function getRealStops(lat, lon, radiusMeters = 500) {
  if (!rawDb) throw new Error("GTFS DB not loaded yet");

  const rows = rawDb
    .prepare("SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops")
    .all();

  return rows
    .map(s => ({
      ...s,
      distance: haversine(lat, lon, s.stop_lat, s.stop_lon)
    }))
    .filter(s => s.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance);
}
