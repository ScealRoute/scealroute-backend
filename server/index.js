// index.js – ScealRoute Backend (Supabase + GTFS Hybrid)
// Features: Real-time API via Node.js, Persistent Data via Supabase.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js'; // <--- NEW
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import fetch from 'node-fetch';
import Long from 'long';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// --- SUPABASE SETUP ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error("❌ MISSING SUPABASE CREDENTIALS in .env");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("✅ Connected to Supabase");

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const PORT = process.env.PORT || 8080;

// --- STATIC DATA LOADERS ---
const realStops = [];
const routesList = [];
const routesById = {};

async function loadStaticData() {
  console.log("📂 Loading Static GTFS...");
  
  // STOPS
  await new Promise(resolve => {
      const p = path.join(__dirname, 'data', 'stops.txt');
      if (!fs.existsSync(p)) return resolve();
      fs.createReadStream(p).pipe(csv()).on('data', r => {
          if(r.stop_id) realStops.push({ stop_id: r.stop_id, stop_name: r.stop_name, stop_lat: parseFloat(r.stop_lat), stop_lon: parseFloat(r.stop_lon) });
      }).on('end', () => resolve());
  });

  // ROUTES
  await new Promise(resolve => {
      const p = path.join(__dirname, 'data', 'routes.txt');
      if (!fs.existsSync(p)) return resolve();
      fs.createReadStream(p).pipe(csv()).on('data', r => {
          if(r.route_id) {
              routesList.push({ route_id: r.route_id, short_name: r.route_short_name, long_name: r.route_long_name });
              routesById[r.route_id] = r.route_short_name;
          }
      }).on('end', () => resolve());
  });
  console.log(`✅ Loaded ${realStops.length} stops and ${routesList.length} routes.`);
}

// --- REAL-TIME FEEDS (Same Robust Logic) ---
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

function getSimulatedVehicles() {
    const simVehicles = [];
    const centerLat = 53.3498; const centerLon = -6.2603;
    const routes = ['145', '46A', '39A', '15', '109A'];
    for(let i=0; i<30; i++) {
        simVehicles.push({
            vehicle: {
                id: `sim_${i}`,
                position: { latitude: centerLat + (Math.random()-0.5)*0.15, longitude: centerLon + (Math.random()-0.5)*0.15, bearing: Math.random()*360 },
                trip: { routeId: `60-${routes[i%routes.length]}-b12` }
            }
        });
    }
    return simVehicles;
}

async function refreshFeeds() {
    const now = Date.now();
    if (tripUpdatesCache && (now - lastFetchTime < 15000)) return; 

    const apiKey = process.env.TFI_API_KEY;
    const tripUrl = process.env.TFI_TRIP_UPDATES_URL || 'https://api.nationaltransport.ie/gtfsr/v2/TripUpdates';
    const vehUrl = process.env.TFI_VEHICLE_POSITIONS_URL || 'https://api.nationaltransport.ie/gtfsr/v2/VehiclePositions';

    if (!apiKey) { apiHealthy = false; vehiclePositionsCache = { entity: getSimulatedVehicles() }; return; }
    
    try {
        const uRes = await fetch(tripUrl, { headers: { 'x-api-key': apiKey } });
        if (uRes.ok) {
            tripUpdatesCache = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(await uRes.arrayBuffer()));
            apiHealthy = true;
        } else apiHealthy = false;

        let vRes = await fetch(vehUrl, { headers: { 'x-api-key': apiKey } });
        if (!vRes.ok) vRes = await fetch('https://gtfsr.transportforireland.ie/v2/VehiclePositions', { headers: { 'x-api-key': apiKey } });
        
        if (vRes.ok) {
            vehiclePositionsCache = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(await vRes.arrayBuffer()));
        }

        if (!apiHealthy) vehiclePositionsCache = { entity: getSimulatedVehicles() };
        lastFetchTime = now;
    } catch (e) {
        apiHealthy = false; vehiclePositionsCache = { entity: getSimulatedVehicles() };
    }
}

// --- API ENDPOINTS ---

app.get('/health', async () => ({ ok: true, db: 'Supabase', api: apiHealthy ? 'Live' : 'Sim' }));

// 1. ARRIVALS (Complex Node Logic)
app.get('/stops/:id/arrivals', async (req) => {
    await refreshFeeds();
    const stopId = req.params.id;
    const arrivals = [];
    const now = Date.now();

    if (apiHealthy && tripUpdatesCache?.entity) {
        tripUpdatesCache.entity.forEach(entity => {
            if (entity.tripUpdate?.stopTimeUpdate) {
                const trip = entity.tripUpdate;
                let rawRoute = trip.trip.routeId || '';
                let cleanRoute = rawRoute.includes('-') ? rawRoute.split('-')[1] : rawRoute;

                trip.stopTimeUpdate.forEach(stopUpdate => {
                    if (stopUpdate.stopId === stopId) {
                        const timeSec = safeLongToNumber(stopUpdate.arrival?.time) || safeLongToNumber(stopUpdate.departure?.time);
                        if (timeSec) {
                            const arrivalMs = timeSec * 1000;
                            if (arrivalMs > now - 3600000) {
                                arrivals.push({
                                    route_short_name: cleanRoute, destination: 'City Centre', 
                                    predicted_time: arrivalMs, trip_id: trip.trip.tripId
                                });
                            }
                        }
                    }
                });
            }
        });
    } else if (!apiHealthy) {
        // Sim Fallback
        ['46A','145'].forEach((r,i) => arrivals.push({ route_short_name: r, destination: 'Simulated', predicted_time: now + (i+1)*600000 }));
    }
    
    arrivals.sort((a, b) => a.predicted_time - b.predicted_time);

    // FETCH REPORTS FROM SUPABASE
    const { data: reports } = await supabase
        .from('reports')
        .select('*')
        .eq('stop_id', stopId)
        .gt('created_at', new Date(Date.now() - 3600000).toISOString()); // Last hour

    return { arrivals: arrivals.slice(0, 10), reports: reports || [], lastUpdated: now };
});

// 2. VEHICLES (Complex Node Logic)
const handleRouteVehicles = async (req) => {
    await refreshFeeds();
    let queryId = req.params?.id || req.query?.route_id || '';
    let shortName = routesById[queryId] || queryId;
    if (shortName.includes('_')) shortName = shortName.split('_')[0];
    shortName = shortName.toUpperCase();

    const vehicles = [];
    if (vehiclePositionsCache?.entity) {
        vehiclePositionsCache.entity.forEach(e => {
            if (e.vehicle?.position) {
                const v = e.vehicle;
                const vId = v.id || v.trip?.tripId || 'unk';
                const rawRoute = v.trip?.routeId || '';
                
                if (!apiHealthy || rawRoute.toUpperCase().includes(shortName) || rawRoute.split('-').includes(shortName)) {
                    vehicles.push({
                        id: vId, latitude: v.position.latitude, longitude: v.position.longitude,
                        route_short_name: shortName, bearing: v.position.bearing || 0
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
        vehiclePositionsCache.entity.slice(0, 150).forEach(e => {
            if (e.vehicle?.position) {
                let routeName = e.vehicle.trip?.routeId || 'Bus';
                if(routeName.includes('-')) routeName = routeName.split('-')[1];
                vehicles.push({ id: e.vehicle.id, latitude: e.vehicle.position.latitude, longitude: e.vehicle.position.longitude, route: routeName });
            }
        });
    }
    return { vehicles };
});

// --- SUPABASE INTERACTIONS ---

async function getOrCreateUser(username) {
    const clean = String(username).trim();
    // Try fetch
    const { data, error } = await supabase.from('users').select('*').eq('username', clean).single();
    if (data) return data;
    
    // Create if missing
    const { data: newUser } = await supabase.from('users').insert({ username: clean }).select().single();
    return newUser;
}

app.post('/reports', async (req) => {
    const { username, stop_id, type, note } = req.body;
    await supabase.from('reports').insert({ username, stop_id, type, note });
    // Update XP via RPC or direct update (Simplified here)
    const u = await getOrCreateUser(username);
    await supabase.from('users').update({ xp: u.xp + 10, reports_count: u.reports_count + 1 }).eq('username', username);
    return { ok: true, user: { ...u, xp: u.xp + 10 } };
});

app.post('/traffic/report', async (req) => {
    const { username, lat, lon, type, note } = req.body;
    await supabase.from('traffic').insert({ reported_by: username, lat, lon, type, note });
    const u = await getOrCreateUser(username);
    await supabase.from('users').update({ xp: u.xp + 15, reports_count: u.reports_count + 1 }).eq('username', username);
    return { ok: true, user_xp: u.xp + 15 };
});

app.get('/traffic/nearby', async () => {
    const { data } = await supabase.from('traffic').select('*').gt('created_at', new Date(Date.now() - 3600000).toISOString());
    return { ok: true, reports: data || [] };
});

app.get('/users/:username/reports', async (req) => {
    const { data } = await supabase.from('reports').select('*').eq('username', req.params.username);
    return { ok: true, reports: data || [] };
});

app.get('/users/:username/favourites', async (req) => {
    const u = await getOrCreateUser(req.params.username);
    return { ok: true, favourites: u.favourites || [] };
});

app.post('/users/:username/favourites', async (req) => {
    const { stop_id, favourite } = req.body;
    const u = await getOrCreateUser(req.params.username);
    let newFavs = u.favourites || [];
    
    if (favourite) {
        if (!newFavs.includes(stop_id)) newFavs.push(stop_id);
    } else {
        newFavs = newFavs.filter(id => id !== stop_id);
    }
    
    await supabase.from('users').update({ favourites: newFavs }).eq('username', req.params.username);
    return { ok: true, favourites: newFavs };
});

app.post('/journeys/start', async (req) => {
    const { username, route_short_name, route_long_name } = req.body;
    await supabase.from('journeys').insert({ username, route_short_name, route_long_name });
    return { ok: true };
});

app.get('/users/:username/journeys', async (req) => {
    const { data } = await supabase.from('journeys').select('*').eq('username', req.params.username).order('created_at', { ascending: false }).limit(10);
    return { ok: true, journeys: data || [] };
});

// ALERTS (Placeholder)
app.get('/users/:username/alerts', async () => ({ ok: true, alerts: [] }));
app.post('/alerts/register', async () => ({ ok: true })); 
app.post('/alerts/:id/cancel', async () => ({ ok: true }));

// STATIC SEARCH
app.get('/stops/nearby', async (req) => {
    const lat = parseFloat(req.query.lat); const lon = parseFloat(req.query.lon);
    if (!realStops.length) return [];
    const sorted = [...realStops].sort((a, b) => ((a.stop_lat - lat)**2 + (a.stop_lon - lon)**2) - ((b.stop_lat - lat)**2 + (b.stop_lon - lon)**2));
    return sorted.slice(0, 30);
});
app.get('/stops/search', async (req) => {
    const q = (req.query.q || '').toLowerCase();
    return realStops.filter(s => s.stop_name.toLowerCase().includes(q) || s.stop_id.includes(q)).slice(0,20);
});
app.get('/routes/search', async (req) => {
    const q = (req.query.q || '').toLowerCase();
    return routesList.filter(r => (r.short_name||'').toLowerCase().includes(q) || (r.long_name||'').toLowerCase().includes(q)).slice(0,50);
});
app.post('/stops/by-ids', async (req) => { return realStops.filter(s => (req.body.ids||[]).includes(s.stop_id)); });
app.get('/stops/heat', async () => { return { ok: true, heat: {} }; }); // Placeholder for now

// START
const start = async () => {
  try {
    await loadStaticData();
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`\n🚀 ScealRoute Server (Supabase Edition) running on ${PORT}`);
  } catch (err) { console.error(err); process.exit(1); }
};
start();