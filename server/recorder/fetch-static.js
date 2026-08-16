// Fetch the current NTA GTFS static feed.
//
// The feed that used to live in git was the December 2025 snapshot, and by August 2026 it
// had drifted so far that its identifiers no longer matched the realtime feed at all:
// trip ids joined at 0% and route ids not at all, so route names had to be guessed by
// pattern-matching and destinations fell back to route numbers.
//
// Against the current feed both joins are exact (route_id 98.1%, trip_id 100%), which
// removes the guesswork entirely. NTA republishes regularly, so this must run on a
// schedule rather than being committed.
//
// The archive is ~187 MB but two files account for nearly all of it and nothing reads
// them, so they are skipped: shapes.txt (403 MB uncompressed, map polylines) and
// stop_times.txt (525 MB, the scheduled timetable). Pass --with-stop-times when the
// schedule baseline work needs it.
//
//   node recorder/fetch-static.js
//   node recorder/fetch-static.js --with-stop-times

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { env } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', 'gtfs', 'static');

const FEED_URL = env('GTFS_STATIC_URL', 'https://www.transportforireland.ie/transitData/Data/GTFS_All.zip');

// Everything the code actually reads, plus the calendar files the schedule work will need.
const WANTED = [
  'feed_info.txt',
  'agency.txt',
  'routes.txt',
  'trips.txt',
  'stops.txt',
  'calendar.txt',
  'calendar_dates.txt',
];
const HEAVY = ['stop_times.txt'];

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function requireUnzip() {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    console.error('This needs the `unzip` command on PATH (selective extraction from a 187 MB archive).');
    process.exit(1);
  }
}

async function main() {
  const withStopTimes = process.argv.includes('--with-stop-times');
  const wanted = withStopTimes ? [...WANTED, ...HEAVY] : WANTED;

  requireUnzip();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs-'));
  const zipPath = path.join(tmpDir, 'gtfs.zip');

  console.log(`Fetching ${FEED_URL}`);
  const res = await fetch(FEED_URL);
  if (!res.ok) {
    console.error(`Download failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const lastModified = res.headers.get('last-modified');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zipPath));
  console.log(`Downloaded ${mb(fs.statSync(zipPath).size)}${lastModified ? `, published ${lastModified}` : ''}`);

  // Extract into a staging directory first, so a failure part-way through cannot leave
  // the live static directory half-updated.
  const stageDir = path.join(tmpDir, 'stage');
  fs.mkdirSync(stageDir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zipPath, ...wanted, '-d', stageDir], { stdio: 'inherit' });

  const extracted = fs.readdirSync(stageDir);
  const missing = wanted.filter((f) => !extracted.includes(f));
  if (missing.length) {
    console.error(`Archive did not contain: ${missing.join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(STATIC_DIR, { recursive: true });
  for (const f of extracted) {
    const from = path.join(stageDir, f);
    const to = path.join(STATIC_DIR, f);
    fs.copyFileSync(from, to);
    console.log(`  ${f.padEnd(20)} ${mb(fs.statSync(to).size)}`);
  }

  const info = fs.readFileSync(path.join(STATIC_DIR, 'feed_info.txt'), 'utf8').trim().split('\n');
  const cols = info[0].split(',');
  const vals = info[1].split(',');
  const get = (name) => vals[cols.indexOf(name)];
  console.log(`\nFeed valid ${get('feed_start_date')} to ${get('feed_end_date')}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
