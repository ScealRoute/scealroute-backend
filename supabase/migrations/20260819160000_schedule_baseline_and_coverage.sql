-- Schedule baseline, realtime coverage, and per-stop health.
--
-- Everything here exists to answer one question honestly: when a scheduled trip does not
-- appear in the realtime feed, which of these is it?
--
--   (a) the operator does not publish realtime at all
--   (b) we were not polling at the time
--   (c) the trip did not run
--
-- Only (c) is a ghost. Measured against Tuesday 2026-08-18, (a) alone is 20.3% of all
-- scheduled trips in the country: 81 of 87 operators publish no GTFS-RT whatsoever,
-- including every TFI Local Link service, Aircoach, Dublin Express, Citylink and Swords
-- Express. Six agencies publish: Dublin Bus, Bus Éireann (incl. Waterford), Go-Ahead
-- Ireland, LUAS and Irish Rail.
--
-- Reporting reliability for a route in category (a) would be inventing a number about a
-- service we have never once observed. So coverage is stored as data, per agency per day,
-- and the public views refuse to score anything outside it.

-- ---------------------------------------------------------------------------
-- What was SCHEDULED to run on a date, derived from the static GTFS feed.
--
-- Stored per service date rather than as a copy of trips.txt because the static feed is
-- republished continuously and the schedule for a past date must not change retroactively
-- once we have measured against it. This is the denominator, and a denominator that moves
-- after the fact is worthless.
-- ---------------------------------------------------------------------------
create table if not exists schedule_baseline (
  service_date      date not null,
  trip_id           text not null,
  route_id          text not null,
  agency_id         text,
  route_short_name  text,
  mode              text,
  primary key (service_date, trip_id)
);

create index if not exists schedule_baseline_route_idx
  on schedule_baseline (service_date, route_id);
create index if not exists schedule_baseline_agency_idx
  on schedule_baseline (service_date, agency_id);

-- Provenance for each baseline: which published feed produced it, and when.
-- A baseline built from a feed that had already expired is not evidence.
create table if not exists schedule_baseline_runs (
  service_date      date primary key,
  feed_version      text,
  feed_start_date   date,
  feed_end_date     date,
  scheduled_trips   int not null,
  scheduled_routes  int not null,
  built_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Per-agency realtime coverage, recomputed daily.
--
-- publishes_realtime is derived, never hardcoded: an operator that starts feeding GTFS-RT
-- becomes measurable the next day without a code change, and one that stops is caught
-- rather than silently scored against stale expectations.
-- ---------------------------------------------------------------------------
create table if not exists agency_coverage_daily (
  service_date       date not null,
  agency_id          text not null,
  scheduled_trips    int  not null,
  scheduled_routes   int  not null,
  observed_trips     int  not null,
  observed_routes    int  not null,
  publishes_realtime boolean not null,
  computed_at        timestamptz not null default now(),
  primary key (service_date, agency_id)
);

-- ---------------------------------------------------------------------------
-- How much of the day we were actually watching.
--
-- GitHub Actions runs the recorder in bursts, so polling is not continuous: on
-- 2026-08-18 there were 421 successful polls with a longest gap of 77 minutes. Any
-- statement about a trip failing to appear is bounded by this, so it travels with every
-- count of unobserved trips rather than living in a footnote.
--
-- watched_seconds credits each successful poll with the time until the next one, capped
-- at POLL_VALIDITY. The cap is what stops a 77-minute gap from being counted as 77
-- minutes of observation.
-- ---------------------------------------------------------------------------
create or replace view poll_coverage_daily as
with p as (
  select (polled_at at time zone 'Europe/Dublin')::date as service_date,
         polled_at,
         lead(polled_at) over (partition by (polled_at at time zone 'Europe/Dublin')::date
                               order by polled_at) as next_polled_at
    from feed_polls
   where ok
)
select
  service_date,
  count(*)::int                                                          as polls,
  round(max(extract(epoch from next_polled_at - polled_at)))::int        as longest_gap_seconds,
  round(percentile_cont(0.5) within group (
        order by extract(epoch from next_polled_at - polled_at)))::int   as median_gap_seconds,
  round(sum(least(extract(epoch from coalesce(next_polled_at, polled_at + interval '60 seconds')
                          - polled_at), 60)))::int                       as watched_seconds,
  round(100.0 * sum(least(extract(epoch from coalesce(next_polled_at, polled_at + interval '60 seconds')
                          - polled_at), 60)) / 86400.0, 1)               as watched_pct
from p
group by service_date;

-- ---------------------------------------------------------------------------
-- Per-stop, per-route reliability.
--
-- This is the record that does not exist anywhere else. NTA publishes quarterly aggregate
-- Lost Kilometre Rate per operator; nobody publishes "the 8:14 from this pole is late four
-- days in five". Keyed by stop and route together because a route can run well on one leg
-- and badly on another, and the passenger only ever experiences one stop.
-- ---------------------------------------------------------------------------
create table if not exists stop_health_daily (
  service_date        date not null,
  stop_id             text not null,
  route_id            text not null,
  route_short_name    text,
  mode                text,

  stop_events         int not null,
  stop_events_with_delay int not null,

  on_time_events      int not null,
  late_events         int not null,
  early_events        int not null,
  very_late_events    int not null,

  avg_delay_seconds   numeric,
  p50_delay_seconds   int,
  p90_delay_seconds   int,
  max_delay_seconds   int,

  computed_at         timestamptz not null default now(),
  primary key (service_date, stop_id, route_id)
);

create index if not exists stop_health_daily_stop_idx on stop_health_daily (stop_id, service_date desc);

-- Add the schedule side to the route rollup. Nullable because a date recorded before the
-- baseline existed genuinely has no denominator, and zero would be a lie.
alter table route_health_daily add column if not exists scheduled_trips  int;
alter table route_health_daily add column if not exists unobserved_trips int;
alter table route_health_daily add column if not exists agency_id        text;
