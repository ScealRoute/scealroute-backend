// index.js – FINAL (With Route Ratings & Upvoting)
import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js'; 
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import fetch from 'node-fetch';
import Long from 'long';

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
let tripUpdatesCache = null;
let vehiclePositionsCache = null;
let lastFetchTime = 0;
let apiHealthy = false;

function safeLongToNumber(longVal) {
    if (!longVal) return null;
    if (typeof longVal === 'number') return longVal;
    if (Long.isLong(longVal)) return longVal.toNumber();
    if (longVal.low !== undefined) return new Long(longVal.low, longVal.high, longVal.unsigned).toNumber();
    return null;
}

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
}

// --- REAL-TIME FEEDS ---
async function refreshFeeds() {
    const now = Date.now();
    if (tripUpdatesCache && (now - lastFetchTime < 10000)) return; 

    const apiKey = process.env.TFI_API_KEY;
    const tripUrl = process.env.TFI_TRIP_UPDATES_URL || 'https://api.nationaltransport.ie/gtfsr/v2/TripUpdates';
    const vehUrl = process.env.TFI_VEHICLE_POSITIONS_URL || 'https://api.nationaltransport.ie/gtfsr/v2/VehiclePositions';

    if (!apiKey) { console.warn("❌ No TFI_API_KEY"); return; }

    try {
        const uRes = await fetch(tripUrl, { headers: { 'x-api-key': apiKey } });
        if (uRes.ok) {
            const buffer = await uRes.arrayBuffer();
            tripUpdatesCache = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
            apiHealthy = true;
        }

        const vRes = await fetch(vehUrl, { headers: { 'x-api-key': apiKey } });
        if (vRes.ok) {
            const buffer = await vRes.arrayBuffer();
            vehiclePositionsCache = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
        }
        lastFetchTime = now;
    } catch (e) {
        console.error("🔥 API Error:", e.message);
        apiHealthy = false;
    }
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
app.get('/stops/:id/arrivals', async (req) => {
    await refreshFeeds();
    const stopId = req.params.id; 
    const arrivals = [];
    const now = Date.now();
    const targetSuffix = stopId.length > 4 ? stopId.slice(-4) : stopId;

    if (apiHealthy && tripUpdatesCache?.entity) {
        tripUpdatesCache.entity.forEach(entity => {
            if (entity.tripUpdate?.stopTimeUpdate) {
                const trip = entity.tripUpdate;
                let cleanRoute = trip.trip.routeId || '';
                if (cleanRoute.includes('-')) cleanRoute = cleanRoute.split('-')[1];

                trip.stopTimeUpdate.forEach(stopUpdate => {
                    const apiStopId = stopUpdate.stopId || "";
                    const isMatch = apiStopId === stopId || apiStopId.endsWith(targetSuffix) || stopId.endsWith(apiStopId);

                    if (isMatch) {
                        const timeSec = safeLongToNumber(stopUpdate.arrival?.time) || safeLongToNumber(stopUpdate.departure?.time);
                        if (timeSec) {
                            const arrivalMs = timeSec * 1000;
                            if (arrivalMs > now - 3600000) {
                                arrivals.push({
                                    route_short_name: cleanRoute, 
                                    destination: 'City Centre', 
                                    predicted_time: arrivalMs, 
                                    trip_id: trip.trip.tripId,
                                    status: 'LIVE'
                                });
                            }
                        }
                    }
                });
            }
        });
    }
    
    arrivals.sort((a, b) => a.predicted_time - b.predicted_time);

    // FETCH REPORTS & CALCULATE CHAOS RATING
    const { data: reports } = await supabase
        .from('reports')
        .select('*')
        .eq('stop_id', stopId)
        .gt('created_at', new Date(Date.now() - 3600000).toISOString()); // Last hour only
    
    const status = calculateStopStatus(reports ? reports.length : 0);

    return { 
        arrivals: arrivals.slice(0, 10), 
        reports: reports || [], 
        status: status, // <--- Returns { status: 'Chaos', color: 'red' }
        lastUpdated: now 
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

// 4. VEHICLES
const handleRouteVehicles = async (req) => {
    await refreshFeeds();
    let queryId = req.params?.id || req.query?.route_id || '';
    let shortName = routesById[queryId] || queryId;
    if (shortName.includes('_')) shortName = shortName.split('_')[0];
    if (shortName.includes('-')) shortName = shortName.split('-')[1];
    shortName = shortName.toUpperCase();

    const vehicles = [];
    if (vehiclePositionsCache?.entity) {
        vehiclePositionsCache.entity.forEach(e => {
            if (e.vehicle?.position) {
                const v = e.vehicle;
                let routeName = v.trip?.routeId || '';
                if(routeName.includes('-')) routeName = routeName.split('-')[1];
                if (routeName.toUpperCase() === shortName) {
                     vehicles.push({
                        id: v.id || v.trip?.tripId || `bus_${Math.random()}`,
                        latitude: v.position.latitude, 
                        longitude: v.position.longitude,
                        route: routeName,
                        bearing: v.position.bearing || 0
                    });
                }
            }
        });
    }
    return { vehicles };
};
app.get('/route-vehicles', handleRouteVehicles);
app.get('/routes/:id/vehicles', handleRouteVehicles);

app.get('/vehicles', async () => {
    await refreshFeeds();
    const vehicles = [];
    if (vehiclePositionsCache?.entity) {
        vehiclePositionsCache.entity.slice(0, 200).forEach(e => {
            if (e.vehicle?.position) {
                const safeId = e.vehicle.id || e.vehicle.trip?.tripId || `bus_${Math.random()}`;
                let routeName = e.vehicle.trip?.routeId || 'Bus';
                if(routeName.includes('-')) routeName = routeName.split('-')[1];
                vehicles.push({ id: safeId, latitude: e.vehicle.position.latitude, longitude: e.vehicle.position.longitude, route: routeName });
            }
        });
    }
    return { vehicles };
});

// 5. USER & FAVOURITES
async function getOrCreateUser(username) {
    const clean = String(username).trim();
    const { data } = await supabase.from('users').select('*').eq('username', clean).single();
    if (data) return data;
    const { data: newUser } = await supabase.from('users').insert({ username: clean, favourites: [], xp: 0 }).select().single();
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
    await supabase.from('users').update({ favourites: newFavs }).eq('username', u.username);
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
    const sorted = [...realStops].sort((a, b) => ((a.stop_lat - lat)**2 + (a.stop_lon - lon)**2) - ((b.stop_lat - lat)**2 + (b.stop_lon - lon)**2));
    return sorted.slice(0, 30);
});
app.get('/stops/heat', async () => { return { ok: true, heat: {} }; });
app.get('/health', async () => ({ ok: true }));

// START
const start = async () => {
  try {
    await loadStaticData();
    console.log("⚡ Startup: Checking TFI...");
    await refreshFeeds(); 
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`\n🚀 ScealRoute Server (Production) running on ${PORT}`);
  } catch (err) { console.error(err); process.exit(1); }
};
start();