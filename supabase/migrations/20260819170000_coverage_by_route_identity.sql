-- Realtime coverage must be decided on route_id, not trip_id.
--
-- Measured on 2026-08-18, trip ids join between the static and realtime feeds at 98% for
-- Dublin Bus, 85% for Bus Éireann and 100% for Go-Ahead — but at exactly 0% for both
-- Irish Rail and the LUAS, whose realtime trip identifiers come from a different space
-- entirely. Their route ids join at 100%.
--
-- Deciding coverage on the trip join therefore declared Irish Rail and the LUAS to be
-- operators that publish no realtime feed, which is false and would have erased rail and
-- tram from the public record while their arrivals were being recorded all along. It would
-- also have reported all 1,342 scheduled LUAS trips as unobserved every single day: a
-- fabricated ghost figure for a service that ran normally.
--
-- route_id is the identity this schema already chose (see the August 16 migration), and it
-- is the one that holds across every mode. The trip join is kept, but demoted to what it
-- honestly is: a measure of whether non-appearance is answerable for that operator at all.

alter table agency_coverage_daily add column if not exists trip_ids_joinable boolean;

create or replace function compute_agency_coverage(target_date date)
returns int
language plpgsql
as $$
declare
  affected int;
begin
  delete from agency_coverage_daily where service_date = target_date;

  insert into agency_coverage_daily (
    service_date, agency_id, scheduled_trips, scheduled_routes,
    observed_trips, observed_routes, publishes_realtime, trip_ids_joinable
  )
  select
    b.service_date,
    coalesce(b.agency_id, 'unknown')                                    as agency_id,
    count(*)::int                                                       as scheduled_trips,
    count(distinct b.route_id)::int                                     as scheduled_routes,
    count(*) filter (where b.trip_seen)::int                            as observed_trips,
    count(distinct b.route_id) filter (where b.route_seen)::int         as observed_routes,

    -- One observed route is enough to prove the feed exists for this operator.
    count(*) filter (where b.route_seen) > 0                            as publishes_realtime,

    -- Whether "this trip never appeared" is even a question we can ask. Half is a wide
    -- margin deliberately: it separates a feed whose ids join from one whose ids do not,
    -- and nothing observed sits near the boundary (the real values are 0%, or 85%+).
    count(*) filter (where b.trip_seen) > count(*) * 0.5                as trip_ids_joinable
  from (
    select b.*,
           exists (select 1 from trip_presence p
                    where p.service_date = b.service_date and p.trip_id = b.trip_id) as trip_seen,
           exists (select 1 from trip_presence p
                    where p.service_date = b.service_date and p.route_id = b.route_id) as route_seen
      from schedule_baseline b
     where b.service_date = target_date
  ) b
  group by b.service_date, coalesce(b.agency_id, 'unknown');

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Same correction one level down, applied per route rather than per agency so it stays
-- true for a single anomalous route inside an otherwise well-behaved operator.
--
-- The rule: a route we observed in the realtime feed, but whose scheduled trips produced
-- no trip-id matches at all, has incomparable identifiers. Its non-appearance count is
-- null — unmeasurable — never the full scheduled count.
create or replace function compute_route_health(target_date date)
returns int
language plpgsql
as $$
declare
  affected int;
begin
  delete from route_health_daily where service_date = target_date;

  insert into route_health_daily (
    service_date, route_id, route_short_name, mode, agency_id,
    trips_seen, stop_events, stop_events_with_delay,
    on_time_events, late_events, early_events, very_late_events,
    avg_delay_seconds, p50_delay_seconds, p90_delay_seconds, max_delay_seconds,
    cancelled_trips, scheduled_trips, unobserved_trips
  )
  select
    o.service_date,
    o.route_id,
    mode() within group (order by o.route_short_name),
    mode() within group (order by o.mode),
    sched.agency_id,

    count(distinct o.trip_id),
    count(*),
    count(o.last_delay_seconds),

    count(*) filter (where o.last_delay_seconds between -60 and 300),
    count(*) filter (where o.last_delay_seconds > 300),
    count(*) filter (where o.last_delay_seconds < -60),
    count(*) filter (where o.last_delay_seconds > 600),

    round(avg(o.last_delay_seconds)::numeric, 1),
    percentile_cont(0.5) within group (order by o.last_delay_seconds)::int,
    percentile_cont(0.9) within group (order by o.last_delay_seconds)::int,
    max(o.last_delay_seconds),

    (select count(distinct t.trip_id) from trip_presence t
      where t.service_date = o.service_date
        and t.route_id = o.route_id
        and t.schedule_relationship = 3),

    sched.scheduled_trips,
    case
      when sched.scheduled_trips is null then null   -- no baseline for this route
      when sched.observed_trips = 0     then null   -- identifiers do not join; unmeasurable
      else greatest(sched.scheduled_trips - sched.observed_trips, 0)
    end
  from stop_observations o
  left join lateral (
    select count(*)::int as scheduled_trips,
           count(*) filter (where exists (
             select 1 from trip_presence p
              where p.service_date = b.service_date and p.trip_id = b.trip_id))::int as observed_trips,
           mode() within group (order by b.agency_id) as agency_id
      from schedule_baseline b
     where b.service_date = o.service_date and b.route_id = o.route_id
    having count(*) > 0
  ) sched on true
  where o.service_date = target_date
    and o.route_id is not null
  group by o.service_date, o.route_id,
           sched.scheduled_trips, sched.observed_trips, sched.agency_id;

  get diagnostics affected = row_count;
  return affected;
end;
$$;
