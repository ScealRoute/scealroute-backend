// Read the scheduled time span of every trip out of stop_times.txt.
//
// This exists to make one specific claim testable. Of 877 scheduled trips nationally that
// never appeared in the realtime feed on 2026-08-21, 825 were Bus Éireann, against 2 of
// 8,048 for Dublin Bus. Published as-is that reads as a 8.8% cancellation rate for one
// operator, and it must not be, because a far more likely explanation is that their feed
// stops describing trips at certain times of day.
//
// A time span per trip separates the two. If the misses cluster at the edges of the
// service day, where a realtime feed plausibly falls silent, it is a feed artifact. If
// they spread evenly across the day, the schedule was not run. Nothing else in the data
// distinguishes those, which is why the baseline could not answer it before.
//
// Times are stored as seconds from the start of the service day, not as clock times,
// because GTFS runs past midnight rather than wrapping: departures in this feed reach
// hour 32, and 25:30:00 is a real value that a `time` column would reject. Seconds keep
// a 00:40 night service after the 23:50 that precedes it instead of sorting it to dawn.

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', 'gtfs', 'static');
const STOP_TIMES = path.join(STATIC_DIR, 'stop_times.txt');

export function stopTimesAvailable() {
  return fs.existsSync(STOP_TIMES);
}

export const stopTimesPath = STOP_TIMES;

// "25:30:00" -> 91800. Returns null for anything that is not HH:MM:SS, which GTFS permits
// for intermediate stops on a trip that is only timed at some of them.
function toSeconds(hhmmss) {
  const a = hhmmss.indexOf(':');
  if (a < 1) return null;
  const b = hhmmss.indexOf(':', a + 1);
  if (b < 0) return null;
  const h = Number(hhmmss.slice(0, a));
  const m = Number(hhmmss.slice(a + 1, b));
  const s = Number(hhmmss.slice(b + 1));
  if (!Number.isInteger(h) || !Number.isInteger(m) || !Number.isInteger(s)) return null;
  return h * 3600 + m * 60 + s;
}

/**
 * Map of trip_id -> { first, last, stops }, in seconds from the start of the service day.
 *
 * The file is 10 million rows and half a gigabyte, so it is scanned once, by hand, rather
 * than parsed into row objects: a CSV parser here allocates ten million short-lived
 * objects to read three fields off the front of each line. The three fields wanted all sit
 * before stop_headsign, the only column in this file that can carry a quoted comma, so
 * splitting on commas by position is safe. Lines that do not parse are counted and
 * reported rather than silently dropped.
 *
 * Uses min(departure) and max(arrival) rather than trusting stop_sequence ordering, which
 * is equivalent for a timetable that does not go backwards and does not require the file
 * to arrive sorted.
 */
export async function loadTripTimes({ onProgress } = {}) {
  if (!stopTimesAvailable()) {
    throw new Error('Missing stop_times.txt. Run recorder/fetch-static.js --with-stop-times first.');
  }

  const times = new Map();
  let lines = 0;
  let malformed = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(STOP_TIMES, { highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });

  let header = true;
  for await (const line of rl) {
    if (header) {
      header = false;
      // Guard the positional read: if NTA ever reorders the columns, fail loudly here
      // rather than silently recording stop ids as departure times.
      const cols = line.replace(/\r$/, '').split(',');
      if (cols[0] !== 'trip_id' || cols[1] !== 'arrival_time' || cols[2] !== 'departure_time') {
        throw new Error(`stop_times.txt columns changed: expected trip_id,arrival_time,departure_time, got ${cols.slice(0, 3).join(',')}`);
      }
      continue;
    }
    if (!line) continue;
    lines++;

    const c1 = line.indexOf(',');
    const c2 = c1 < 0 ? -1 : line.indexOf(',', c1 + 1);
    const c3 = c2 < 0 ? -1 : line.indexOf(',', c2 + 1);
    if (c3 < 0) { malformed++; continue; }

    const tripId = line.slice(0, c1);
    const arrival = toSeconds(line.slice(c1 + 1, c2));
    const departure = toSeconds(line.slice(c2 + 1, c3));
    if (arrival === null && departure === null) { malformed++; continue; }

    const entry = times.get(tripId);
    if (!entry) {
      times.set(tripId, {
        first: departure ?? arrival,
        last: arrival ?? departure,
        stops: 1,
      });
      continue;
    }
    if (departure !== null && departure < entry.first) entry.first = departure;
    if (arrival !== null && arrival > entry.last) entry.last = arrival;
    entry.stops++;

    if (onProgress && lines % 1000000 === 0) onProgress(lines, times.size);
  }

  return { times, lines, malformed };
}
