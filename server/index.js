// index.js – FINAL (With Route Ratings & Upvoting)
import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js'; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// --- SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error("❌ MISSING SUPABASE CREDENTIALS");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("✅ Connected to Supabase");

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const PORT = process.env.PORT || 8080;

// --- DATA CONTAINERS ---
const realStops = [];
const routesList = [];
const routesById = {};
const tripHeadsigns = {}; // tripId → headsign

// Route naming now happens in the recorder, which writes route_short_name alongside each
// observation. Parsing it here as well would be a second, divergent implementation of the
// same guesswork.

// --- HELPER: CALCULATE ROUTE STATUS (RESTORED) ---
function calculateStopStatus(reportCount) {
    if (!reportCount || reportCount === 0) return { status: 'Smooth Service', color: '#10b981' }; // Green
    if (reportCount < 3) return { status: 'Minor Issues', color: '#f59e0b' }; // Orange
    if (reportCount < 6) return { status: 'Unreliable', color: '#f97316' }; // Dark Orange
    return { status: 'CHAOS', color: '#ef4444' }; // Red
}

// --- LOAD DATA ---
async function loadStaticData() {
  console.log("📂 Loading Static GTFS...");
  
  // STOPS
  await new Promise(resolve => {
      const p = path.join(__dirname, 'gtfs', 'static', 'stops.txt');
      if (!fs.existsSync(p)) return resolve();
      let rowCount = 0;
      fs.createReadStream(p)
        .pipe(csv())
        .on('data', r => {
            if(r.stop_id) {
                realStops.push({ 
                    stop_id: r.stop_id, 
                    stop_name: r.stop_name, 
                    stop_lat: parseFloat(r.stop_lat), 
                    stop_lon: parseFloat(r.stop_lon) 
                });
                rowCount++;
            }
        })
        .on('end', () => { console.log(`✅ Loaded ${rowCount} stops.`); resolve(); });
  });

  // ROUTES
  await new Promise(resolve => {
      const p = path.join(__dirname, 'gtfs', 'static', 'routes.txt');
      if (!fs.existsSync(p)) return resolve();
      fs.createReadStream(p).pipe(csv()).on('data', r => {
          if(r.route_id) {
              routesList.push({ 
                  route_id: r.route_id, 
                  short_name: r.route_short_name, 
                  long_name: r.route_long_name 
              });
              routesById[r.route_id] = r.route_short_name;
          }
      }).on('end', () => resolve());
  });

  // TRIP HEADSIGNS
  await new Promise(resolve => {
      const p = path.join(__dirname, 'gtfs', 'static', 'trips.txt');
      if (!fs.existsSync(p)) return resolve();
      fs.createReadStream(p).pipe(csv()).on('data', r => {
          if (r.trip_id && r.trip_headsign) {
              tripHeadsigns[r.trip_id] = r.trip_headsign;
          }
      }).on('end', () => { console.log(`✅ Loaded ${Object.keys(tripHeadsigns).length} trip headsigns.`); resolve(); });
  });
}

// --- REAL-TIME FEEDS ---
//
// This server no longer fetches from TFI. The recorder (server/recorder) is the single
// poller and this reads what it wrote.
//
// The TFI quota is 3 requests/minute pooled across every GTFS-RT endpoint on the key.
// The old refreshFeeds() fetched two endpoints behind one 30s gate, which is 4 req/min,
// so it was permanently over budget on its own. Running it alongside the recorder starved
// both and neither got data.
//
// Reading from the database also removes the per-request full-feed scan, and means this
// API can run on any number of instances without touching the quota at all.

const FEED_STALE_AFTER_MS = 3 * 60 * 1000;

/** Service date, not calendar date. Must match the recorder's definition exactly. */
function serviceDateFor(date = new Date()) {
    const d = new Date(date);
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

/**
 * Freshness of the recorded data, so arrivals can be labelled honestly.
 * The old code set apiHealthy=true on success and only ever cleared it on a thrown
 * network error, so a 429 left stale cache being served as "LIVE" indefinitely.
 */
async function feedFreshness() {
    const { data } = await supabase
        .from('feed_polls')
        .select('polled_at, feed_timestamp, ok')
        .eq('ok', true)
        .order('polled_at', { ascending: false })
        .limit(1);

    const last = data?.[0];
    if (!last) return { fresh: false, ageSeconds: null, lastPollAt: null };

    const ageMs = Date.now() - new Date(last.feed_timestamp || last.polled_at).getTime();
    return {
        fresh: ageMs < FEED_STALE_AFTER_MS,
        ageSeconds: Math.round(ageMs / 1000),
        lastPollAt: last.polled_at,
    };
}



// --- ENDPOINTS ---

// 1. WEATHER
app.get('/weather', async (req) => {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    const lat = req.query.lat || 53.3498;
    const lon = req.query.lon || -6.2603;

    if (!apiKey) return { temp: 15, condition: 'Fair', location: 'Demo Mode', icon: '01d' }; 

    try {
        const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}`;
        const res = await fetch(url);
        const data = await res.json();
        return { 
            temp: Math.round(data.main.temp), 
            condition: data.weather[0].main, 
            location: data.name, 
            icon: data.weather[0].icon 
        };
    } catch (e) {
        return { temp: 14, condition: 'Cloudy', location: 'Ireland', icon: '03d' };
    }
});

// 2. LIVE ARRIVALS + ROUTE RATING
//
// Served from what the recorder wrote, not from a feed fetch on the request path.
// Stop ids in the realtime feed match the static ids exactly, so the old suffix-matching
// fallback is gone: it could attach another stop's arrivals to this one, which is a worse
// failure than showing nothing.
app.get('/stops/:id/arrivals', async (req) => {
    const stopId = req.params.id;
    const now = Date.now();

    const [{ data: observations }, { data: reports }, freshness] = await Promise.all([
        supabase
            .from('stop_observations')
            .select('trip_id, route_id, route_short_name, mode, last_predicted_time, last_delay_seconds, last_seen_at')
            .eq('service_date', serviceDateFor())
            .eq('stop_id', stopId)
            .order('last_predicted_time', { ascending: true, nullsFirst: false })
            .limit(60),
        supabase
            .from('reports')
            .select('*')
            .eq('stop_id', stopId)
            .gt('created_at', new Date(now - 3600000).toISOString()),
        feedFreshness(),
    ]);

    const arrivals = (observations || [])
        // Only forward-looking arrivals. A small grace window keeps a bus that is just
        // due from vanishing off the board.
        .filter(o => o.last_predicted_time && new Date(o.last_predicted_time).getTime() > now - 120000)
        .map(o => {
            const headsign = tripHeadsigns[o.trip_id] || null;
            const label = o.route_short_name || o.route_id || 'Service';
            return {
                route_short_name: label,
                destination: headsign || label,
                predicted_time: new Date(o.last_predicted_time).getTime(),
                delay_seconds: o.last_delay_seconds,
                trip_id: o.trip_id,
                mode: o.mode,
                // Honest, not asserted. Freshness is measured from the last successful poll.
                status: freshness.fresh ? 'LIVE' : 'STALE',
            };
        })
        .sort((a, b) => a.predicted_time - b.predicted_time)
        .slice(0, 10);

    const status = calculateStopStatus(reports ? reports.length : 0);

    return {
        arrivals,
        reports: reports || [],
        status,
        feed: {
            fresh: freshness.fresh,
            age_seconds: freshness.ageSeconds,
            last_poll_at: freshness.lastPollAt,
        },
        lastUpdated: now,
    };
});

// 3. SEARCH
app.get('/stops/search', async (req) => {
    const q = (req.query.q || '').toLowerCase();
    return realStops.filter(s => s.stop_name.toLowerCase().includes(q) || s.stop_id.includes(q)).slice(0,20);
});
app.get('/routes/search', async (req) => {
    const q = (req.query.q || '').toLowerCase();
    return routesList.filter(r => (r.short_name||'').toLowerCase().includes(q) || (r.long_name||'').toLowerCase().includes(q)).slice(0,50);
});

// 4. VEHICLES — retired
//
// Live vehicle positions are no longer served. Two reasons, in order of weight:
//
//   1. Coverage. The VehiclePositions feed carries roughly 878 vehicles against 2,149
//      live trips, so about three in five buses running have no GPS position at all.
//      A map that silently omits most of the fleet misleads more than it informs.
//   2. Quota. Polling it costs requests from the same 3/min budget the recorder needs,
//      and arrival times matter more to a passenger than a moving dot.
//
// The endpoints stay so existing app builds keep working rather than erroring; they
// return an empty list and say why.
const retiredVehiclesEndpoint = async () => ({
    vehicles: [],
    retired: true,
    reason: 'Live vehicle positions are not served: the TFI feed covers only ~41% of running trips.',
});
app.get('/route-vehicles', retiredVehiclesEndpoint);
app.get('/routes/:id/vehicles', retiredVehiclesEndpoint);
app.get('/vehicles', retiredVehiclesEndpoint);

// 5. USER & FAVOURITES
async function getOrCreateUser(username) {
    const clean = String(username).trim();
    const { data, error } = await supabase.from('users').select('*').eq('username', clean).single();
    if (error && error.code !== 'PGRST116') console.error('❌ Supabase select user error:', error.message);
    if (data) return data;
    const { data: newUser, error: insertError } = await supabase.from('users').insert({ username: clean, favourites: [], xp: 0 }).select().single();
    if (insertError) console.error('❌ Supabase insert user error:', insertError.message);
    return newUser || { username: clean, favourites: [], xp: 0 };
}
app.get('/users/:username/favourites', async (req) => {
    const u = await getOrCreateUser(req.params.username);
    return { ok: true, favourites: u.favourites || [] };
});
app.post('/users/:username/favourites', async (req) => {
    const { stop_id, favourite } = req.body;
    const u = await getOrCreateUser(req.params.username);
    let newFavs = u.favourites || [];
    if (favourite) { if (!newFavs.includes(stop_id)) newFavs.push(stop_id); } 
    else { newFavs = newFavs.filter(id => id !== stop_id); }
    const { error: updateError } = await supabase.from('users').update({ favourites: newFavs }).eq('username', u.username);
    if (updateError) console.error('❌ Supabase update favourites error:', updateError.message);
    return { ok: true, favourites: newFavs };
});

// 6. REPORTS & UPVOTES (RESTORED)
app.post('/reports', async (req) => {
    const { username, stop_id, type, note } = req.body;
    await supabase.from('reports').insert({ username, stop_id, type, note });
    
    // Update and RETURN user for Frontend
    const u = await getOrCreateUser(username);
    const newXp = (u.xp || 0) + 10;
    const newCount = (u.reports_count || 0) + 1;
    
    const { data: updatedUser } = await supabase
        .from('users')
        .update({ xp: newXp, reports_count: newCount })
        .eq('username', username)
        .select()
        .single();

    return { ok: true, user: updatedUser || { ...u, xp: newXp, reports_count: newCount } };
});

// ** NEW: UPVOTE ENDPOINT **
app.post('/reports/:id/upvote', async (req) => {
    const reportId = req.params.id;
    // Simple increment (in production you might check if user already voted)
    const { data: report } = await supabase.from('reports').select('upvotes').eq('id', reportId).single();
    const newCount = (report?.upvotes || 0) + 1;
    
    await supabase.from('reports').update({ upvotes: newCount }).eq('id', reportId);
    return { ok: true, upvotes: newCount };
});

app.post('/traffic/report', async (req) => {
    const { username, lat, lon, type, note } = req.body;
    await supabase.from('traffic').insert({ reported_by: username, lat, lon, type, note });
    
    const u = await getOrCreateUser(username);
    const newXp = (u.xp || 0) + 15;
    const newCount = (u.reports_count || 0) + 1;

    await supabase.from('users').update({ xp: newXp, reports_count: newCount }).eq('username', username);
    return { ok: true, user_xp: newXp };
});

app.get('/users/:username/reports', async (req) => {
    const { data } = await supabase.from('reports').select('*').eq('username', req.params.username);
    return { ok: true, reports: data || [] };
});
app.get('/traffic/nearby', async () => {
    const { data } = await supabase.from('traffic').select('*').gt('created_at', new Date(Date.now() - 3600000).toISOString());
    return { ok: true, reports: data || [] };
});
app.post('/stops/by-ids', async (req) => { return realStops.filter(s => (req.body.ids||[]).includes(s.stop_id)); });
app.get('/stops/nearby', async (req) => {
    const lat = parseFloat(req.query.lat); const lon = parseFloat(req.query.lon);
    if (!realStops.length) return [];
    const delta = 0.05; // ~5km bounding box pre-filter before expensive sort
    const candidates = realStops.filter(s => Math.abs(s.stop_lat - lat) < delta && Math.abs(s.stop_lon - lon) < delta);
    const pool = candidates.length > 0 ? candidates : realStops;
    const sorted = pool.sort((a, b) => ((a.stop_lat - lat)**2 + (a.stop_lon - lon)**2) - ((b.stop_lat - lat)**2 + (b.stop_lon - lon)**2));
    return sorted.slice(0, 30);
});
app.get('/stops/heat', async () => { return { ok: true, heat: {} }; });
app.get('/health', async () => ({ ok: true }));

// 7. JOURNEYS
app.post('/journeys/start', async (req) => {
    const { username, route_short_name, route_long_name } = req.body;
    await supabase.from('journeys').insert({ username, route_short_name, route_long_name });
    return { ok: true };
});
app.get('/users/:username/journeys', async (req) => {
    const { data } = await supabase.from('journeys').select('*').eq('username', req.params.username).order('created_at', { ascending: false });
    return { ok: true, journeys: data || [] };
});

// 8. ALERTS
app.get('/users/:username/alerts', async (req) => {
    const { data } = await supabase.from('alerts').select('*').eq('username', req.params.username);
    return { ok: true, alerts: data || [] };
});
app.post('/alerts/register', async (req) => {
    const { username, stop_id, route_id, threshold_minutes } = req.body;
    const { data } = await supabase.from('alerts').insert({ username, stop_id, route_id, threshold_minutes }).select().single();
    return { ok: true, alert: data };
});
app.post('/alerts/:id/cancel', async (req) => {
    await supabase.from('alerts').delete().eq('id', req.params.id);
    return { ok: true };
});

// 9. STOP REVIEWS
app.get('/stops/:id/reviews', async (req) => {
    const { data } = await supabase
        .from('stop_reviews')
        .select('*')
        .eq('stop_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(20);

    const reviews = data || [];

    // Aggregate stats
    const count = reviews.length;
    const avgOverall = count ? (reviews.reduce((s, r) => s + (r.overall || 0), 0) / count).toFixed(1) : null;

    const mode = (arr, field) => {
        const freq = {};
        arr.forEach(r => { if (r[field]) freq[r[field]] = (freq[r[field]] || 0) + 1; });
        return Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0] || null;
    };

    return {
        ok: true,
        reviews,
        summary: {
            count,
            avg_overall: avgOverall,
            busyness: mode(reviews, 'busyness'),
            shelter: mode(reviews, 'shelter'),
            condition: mode(reviews, 'condition'),
        }
    };
});

app.post('/stops/:id/reviews', async (req) => {
    const { username, overall, busyness, shelter, condition, note } = req.body;
    const stop_id = req.params.id;

    const { data, error } = await supabase
        .from('stop_reviews')
        .insert({ stop_id, username, overall, busyness, shelter, condition, note })
        .select()
        .single();

    if (error) console.error('❌ Supabase insert review error:', error.message);

    // Award XP for reviewing
    const u = await getOrCreateUser(username);
    const newXp = (u.xp || 0) + 5;
    await supabase.from('users').update({ xp: newXp }).eq('username', username);

    return { ok: true, review: data };
});

// START
const start = async () => {
  try {
    await loadStaticData();
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`\n🚀 ScealRoute Server (Production) running on ${PORT}`);
  } catch (err) { console.error(err); process.exit(1); }
};
start();