-- Route health recorder schema
--
-- The recorder captures what the TFI GTFS-Realtime feed asserted, over time, so that
-- route reliability can be computed later. GTFS-RT is a live-only feed with no historical
-- archive, so anything not captured at the time is lost permanently. That shapes the design:
-- these tables store observations faithfully and do as little interpretation as possible.
-- Analysis belongs in the rollup, which can be rewritten and re-run; collection cannot.

-- ---------------------------------------------------------------------------
-- Provenance: one row per poll of the feed.
-- Without this you cannot tell "the bus did not run" from "we were not watching",
-- which is the difference between a defensible statistic and a guess.
-- ---------------------------------------------------------------------------
create table if not exists feed_polls (
  id              bigserial primary key,
  polled_at       timestamptz not null default now(),
  feed            text        not null,              -- 'trip_updates'
  http_status     int         not null,
  ok              boolean     not null,
  feed_timestamp  timestamptz,                       -- header timestamp from the feed itself
  entity_count    int,
  stop_update_count int,
  duration_ms     int,
  error           text
);

create index if not exists feed_polls_polled_at_idx on feed_polls (polled_at desc);

-- ---------------------------------------------------------------------------
-- One row per scheduled stop event we ever saw, per service date.
-- Upserted as the feed updates, so the row accumulates rather than duplicating.
-- ---------------------------------------------------------------------------
create table if not exists stop_observations (
  service_date          date        not null,
  trip_id               text        not null,
  stop_id               text        not null,

  route_id              text,                        -- raw feed routeId, e.g. "2 245 c a"
  route_short_name      text,                        -- resolved where possible, e.g. "245"
  mode                  text,                        -- 'bus' | 'rail'; never blend the two in one score
  stop_sequence         int,

  -- schedule_relationship on the trip: 0 scheduled, 1 added, 2 unscheduled, 3 cancelled
  schedule_relationship smallint,

  first_seen_at         timestamptz not null,
  last_seen_at          timestamptz not null,
  observation_count     int         not null default 1,

  -- prediction drift: the first and latest predicted arrival we were told
  first_predicted_time  timestamptz,
  last_predicted_time   timestamptz,

  -- delay in seconds as reported by the feed (negative = early). Present on ~88% of updates.
  first_delay_seconds   int,
  last_delay_seconds    int,

  primary key (service_date, trip_id, stop_id)
);

create index if not exists stop_observations_route_date_idx
  on stop_observations (service_date, route_short_name);
create index if not exists stop_observations_stop_date_idx
  on stop_observations (service_date, stop_id);

-- ---------------------------------------------------------------------------
-- One row per trip per service date. Cheap presence tracking: lets us ask
-- "did this trip ever appear in the feed, and for how long" without scanning
-- the much larger stop_observations table.
-- ---------------------------------------------------------------------------
create table if not exists trip_presence (
  service_date          date        not null,
  trip_id               text        not null,
  route_id              text,
  route_short_name      text,
  mode                  text,
  schedule_relationship smallint,
  first_seen_at         timestamptz not null,
  last_seen_at          timestamptz not null,
  poll_count            int         not null default 1,
  max_stop_sequence     int,
  primary key (service_date, trip_id)
);

create index if not exists trip_presence_route_date_idx
  on trip_presence (service_date, route_short_name);

-- ---------------------------------------------------------------------------
-- Nightly rollup. Cheap to query, safe to publish, and rebuildable from the
-- tables above if the definition of "on time" changes later.
--
-- Deliberately stores counts alongside every rate, so the denominator can always
-- be shown next to the score. A rate without its denominator is not defensible.
-- ---------------------------------------------------------------------------
create table if not exists route_health_daily (
  service_date        date not null,
  route_short_name    text not null,
  mode                text,

  trips_seen          int  not null,
  stop_events         int  not null,
  stop_events_with_delay int not null,

  on_time_events      int  not null,   -- within the on-time window
  late_events         int  not null,
  early_events        int  not null,
  very_late_events    int  not null,   -- beyond the severe threshold

  avg_delay_seconds   numeric,
  p50_delay_seconds   int,
  p90_delay_seconds   int,
  max_delay_seconds   int,

  cancelled_trips     int not null default 0,

  computed_at         timestamptz not null default now(),
  primary key (service_date, route_short_name)
);

-- ---------------------------------------------------------------------------
-- Retention. Raw observations are large (~500k rows/day nationally). The rollup
-- is the durable asset; raw rows exist so the rollup can be recomputed.
-- Run periodically once a comfortable window is established.
-- ---------------------------------------------------------------------------
-- delete from stop_observations where service_date < current_date - interval '90 days';
-- delete from feed_polls        where polled_at    < now() - interval '90 days';
