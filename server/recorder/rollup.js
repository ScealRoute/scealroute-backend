// Recompute the daily rollups for one or more service dates.
//
// Separate from the recorder because the two have opposite failure modes. Collection is
// irreplaceable: the GTFS-RT feed has no archive, so a poll missed is data lost forever.
// Rollups are pure functions of what was collected, so a bad run is fixed by running it
// again. Keeping them apart means a rollup bug can never take the recorder down with it.
//
//   node recorder/rollup.js 2026-08-18
//   node recorder/rollup.js 2026-08-14 2026-08-18     # inclusive range

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { requireEnv } from './env.js';

dotenv.config();

function datesFromArgs(argv) {
  const args = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (args.length === 0) {
    console.error('Usage: node recorder/rollup.js <date> [end-date]');
    process.exit(1);
  }
  if (args.length === 1) return args;

  const out = [];
  const iso = (d) => d.toISOString().slice(0, 10);
  for (let d = new Date(`${args[0]}T12:00:00Z`); iso(d) <= args[1]; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(iso(d));
  }
  return out;
}

async function main() {
  const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_KEY'));
  const dates = datesFromArgs(process.argv.slice(2));

  let failed = 0;
  for (const date of dates) {
    const { data, error } = await supabase.rpc('compute_daily_rollups', { target_date: date });
    if (error) {
      console.error(`  ${date}: ${error.message}`);
      failed++;
      continue;
    }
    const r = Array.isArray(data) ? data[0] : data;
    console.log(`  ${date}: ${r.agency_rows} agencies, ${r.route_rows} routes, ${r.stop_rows} stop/route pairs`);

    // A rollup that produced no routes means the day recorded nothing, which is worth
    // failing on: it is the signature of the recorder having been down all day.
    if (r.route_rows === 0) {
      console.error(`  ${date}: no routes rolled up — nothing was recorded for this date`);
      failed++;
    }
  }

  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
