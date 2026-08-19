-- Rollups that turn observations plus the schedule baseline into a publishable record.
--
-- Same split as before: collection stores signal, this file stores opinion. Every
-- threshold here is arguable and every one of them can be re-run over the raw tables.

-- ---------------------------------------------------------------------------
-- Which operators are measurable on this date.
--
-- An agency counts as publishing realtime if any of its scheduled trips appeared in the
-- feed at all. One observed trip out of thousands still proves the pipe exists, which is
-- the only thing this flag claims; how much of their service we saw is the separate,
-- quantified observed_trips figure.
-- ---------------------------------------------------------------------------
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
    observed_trips, observed_routes, publishes_realtime
  )
  select
    b.service_date,
    coalesce(b.agency_id, 'unknown'),
    count(*)::int,
    count(distinct b.route_id)::int,
    count(*) filter (where p.trip_id is not null)::int,
    count(distinct b.route_id) filter (where p.trip_id is not null)::int,
    count(*) filter (where p.trip_id is not null) > 0
  from schedule_baseline b
  left join trip_presence p
    on p.service_date = b.service_date and p.trip_id = b.trip_id
  where b.service_date = target_date
  group by b.service_date, coalesce(b.agency_id, 'unknown');

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- ---------------------------------------------------------------------------
-- Per-route health, now with the schedule side attached.
--
-- unobserved_trips is scheduled-minus-seen. It is deliberately NOT called "ghost trips" or
-- "cancellations": at current polling density it is an upper bound that still contains
-- every trip that ran while we happened not to be looking. Turning it into a cancellation
-- rate needs either continuous polling or per-trip scheduled times from stop_times.txt.
-- ---------------------------------------------------------------------------
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
    mode() within group (order by o.route_short_name)          as route_short_name,
    mode() within group (order by o.mode)                      as mode,
    (select mode() within group (order by b.agency_id) from schedule_baseline b
      where b.service_date = o.service_date and b.route_id = o.route_id) as agency_id,

    count(distinct o.trip_id)                                  as trips_seen,
    count(*)                                                   as stop_events,
    count(o.last_delay_seconds)                                as stop_events_with_delay,

    count(*) filter (where o.last_delay_seconds between -60 and 300)  as on_time_events,
    count(*) filter (where o.last_delay_seconds > 300)                as late_events,
    count(*) filter (where o.last_delay_seconds < -60)                as early_events,
    count(*) filter (where o.last_delay_seconds > 600)                as very_late_events,

    round(avg(o.last_delay_seconds)::numeric, 1),
    percentile_cont(0.5) within group (order by o.last_delay_seconds)::int,
    percentile_cont(0.9) within group (order by o.last_delay_seconds)::int,
    max(o.last_delay_seconds),

    (select count(distinct t.trip_id) from trip_presence t
      where t.service_date = o.service_date
        and t.route_id = o.route_id
        and t.schedule_relationship = 3),

    sched.scheduled_trips,
    case when sched.scheduled_trips is null then null
         else greatest(sched.scheduled_trips - sched.observed_trips, 0) end
  from stop_observations o
  left join lateral (
    select count(*)::int as scheduled_trips,
           count(*) filter (where exists (
             select 1 from trip_presence p
              where p.service_date = b.service_date and p.trip_id = b.trip_id))::int
             as observed_trips
      from schedule_baseline b
     where b.service_date = o.service_date and b.route_id = o.route_id
    having count(*) > 0
  ) sched on true
  where o.service_date = target_date
    and o.route_id is not null
  group by o.service_date, o.route_id, sched.scheduled_trips, sched.observed_trips;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- ---------------------------------------------------------------------------
-- Per-stop health. Same thresholds as the route rollup, deliberately: a passenger
-- comparing a stop against its route should not be comparing two definitions of late.
-- ---------------------------------------------------------------------------
create or replace function compute_stop_health(target_date date)
returns int
language plpgsql
as $$
declare
  affected int;
begin
  delete from stop_health_daily where service_date = target_date;

  insert into stop_health_daily (
    service_date, stop_id, route_id, route_short_name, mode,
    stop_events, stop_events_with_delay,
    on_time_events, late_events, early_events, very_late_events,
    avg_delay_seconds, p50_delay_seconds, p90_delay_seconds, max_delay_seconds
  )
  select
    o.service_date, o.stop_id, o.route_id,
    mode() within group (order by o.route_short_name),
    mode() within group (order by o.mode),
    count(*),
    count(o.last_delay_seconds),
    count(*) filter (where o.last_delay_seconds between -60 and 300),
    count(*) filter (where o.last_delay_seconds > 300),
    count(*) filter (where o.last_delay_seconds < -60),
    count(*) filter (where o.last_delay_seconds > 600),
    round(avg(o.last_delay_seconds)::numeric, 1),
    percentile_cont(0.5) within group (order by o.last_delay_seconds)::int,
    percentile_cont(0.9) within group (order by o.last_delay_seconds)::int,
    max(o.last_delay_seconds)
  from stop_observations o
  where o.service_date = target_date
    and o.route_id is not null
  group by o.service_date, o.stop_id, o.route_id;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- One call, so a scheduled job cannot run half the rollup. Order matters: agency coverage
-- feeds nothing here, but route health reads schedule_baseline, so the baseline must
-- already be loaded by the time this runs.
create or replace function compute_daily_rollups(target_date date)
returns table (agency_rows int, route_rows int, stop_rows int)
language plpgsql
as $$
begin
  agency_rows := compute_agency_coverage(target_date);
  route_rows  := compute_route_health(target_date);
  stop_rows   := compute_stop_health(target_date);
  return next;
end;
$$;
