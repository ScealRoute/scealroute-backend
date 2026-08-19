-- Two corrections that decide what may be published.
--
-- 1. RAIL DIRECTION. The realtime feed carries both directions of every rail service
--    (DUB-CORK-I and DUB-CORK-O); routes.txt carries only one (DUB-CORK-O). Half of Irish
--    Rail's route ids therefore cannot join to the schedule by construction, and were
--    landing with a null agency, which excluded them from the public record entirely —
--    4,900 stop events on 2026-08-18, including the whole Bray-Howth DART line.
--
--    The direction suffix is stripped for OPERATOR attribution only. It is deliberately
--    not stripped for the trip denominator: both directions would then each claim the
--    whole service's scheduled trips, doubling it. Rail's scheduled_trips stays exact-match
--    and its unobserved count stays null, which is what the trip ids already forced.
--
-- 2. DELAY BASELINE. A punctuality score is only meaningful if the feed's `delay` is
--    measured against the published timetable. On 2026-08-18 the LUAS Red line reported a
--    median 395 seconds EARLY with 58.7% of stop events early. Bus averages 10.8% early
--    and rail 4.5%; no bus or rail route in the country is majority-early on any day.
--    A tram held at platforms cannot run six minutes early, so that figure describes the
--    feed's baseline, not the service.
--
--    Publishing "the LUAS Red line is 26% on time" would be the most quotable wrong number
--    in this dataset. So a route whose events are majority-early is flagged and its score
--    withheld. The test is mode-agnostic on purpose: it catches a misbehaving bus route the
--    same way, and it clears itself if the feed is corrected, with no code change.

-- Rail ids are ORIGIN-DEST-direction. Anything else is returned unchanged, so bus ids
-- ("2 64 d a") and tram ids ("10000 GREEN g a") pass through untouched.
create or replace function gtfs_route_stem(route_id text)
returns text
language sql
immutable
as $$
  select case
    when route_id ~ '^[A-Z][A-Z/.]*(-[A-Z][A-Z/.]*)+-[IO]$'
      then regexp_replace(route_id, '-[IO]$', '')
    else route_id
  end;
$$;

alter table route_health_daily add column if not exists delay_baseline_suspect boolean;

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
    cancelled_trips, scheduled_trips, unobserved_trips, delay_baseline_suspect
  )
  select
    o.service_date,
    o.route_id,
    mode() within group (order by o.route_short_name),
    mode() within group (order by o.mode),

    -- Operator: exact route first, then the direction-stripped stem for rail.
    coalesce(
      (select mode() within group (order by b.agency_id) from schedule_baseline b
        where b.service_date = o.service_date and b.route_id = o.route_id),
      (select mode() within group (order by b.agency_id) from schedule_baseline b
        where b.service_date = o.service_date
          and gtfs_route_stem(b.route_id) = gtfs_route_stem(o.route_id))
    ),

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
      when sched.scheduled_trips is null then null
      when sched.observed_trips = 0     then null   -- identifiers do not join; unmeasurable
      else greatest(sched.scheduled_trips - sched.observed_trips, 0)
    end,

    count(*) filter (where o.last_delay_seconds < -60) > count(o.last_delay_seconds) * 0.5
  from stop_observations o
  left join lateral (
    select count(*)::int as scheduled_trips,
           count(*) filter (where exists (
             select 1 from trip_presence p
              where p.service_date = b.service_date and p.trip_id = b.trip_id))::int as observed_trips
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

-- Rebuild the public view: a suspect delay baseline withholds the score, and the reason is
-- carried in the row rather than left for a reader to infer from a missing value.
drop view if exists route_health_public;

create view route_health_public as
select
  h.service_date,
  h.route_id,
  h.route_short_name,
  h.mode,
  h.agency_id,

  h.trips_seen,
  h.scheduled_trips,
  h.stop_events                                 as observations,
  h.stop_events_with_delay                      as sample_size,

  case when h.stop_events_with_delay >= 50 and not coalesce(h.delay_baseline_suspect, false)
       then round(100.0 * h.on_time_events / nullif(h.stop_events_with_delay, 0), 1) end
                                                as on_time_pct,
  case when h.stop_events_with_delay >= 50 and not coalesce(h.delay_baseline_suspect, false)
       then round(100.0 * h.very_late_events / nullif(h.stop_events_with_delay, 0), 1) end
                                                as severely_late_pct,

  h.p50_delay_seconds,
  h.p90_delay_seconds,
  h.cancelled_trips,

  h.unobserved_trips,
  c.watched_pct                                 as day_watched_pct,
  c.longest_gap_seconds                         as longest_watch_gap_seconds,

  h.stop_events_with_delay >= 50                as meets_threshold,
  coalesce(a.publishes_realtime, false)         as operator_publishes_realtime,
  coalesce(h.delay_baseline_suspect, false)     as delay_baseline_suspect,

  (h.stop_events_with_delay >= 50
   and coalesce(a.publishes_realtime, false)
   and not coalesce(h.delay_baseline_suspect, false))
                                                as scoreable,

  case
    when not coalesce(a.publishes_realtime, false)  then 'operator publishes no realtime feed'
    when h.stop_events_with_delay < 50              then 'sample below threshold'
    when coalesce(h.delay_baseline_suspect, false)  then 'feed delay not measured against the timetable'
  end                                           as withheld_reason
from route_health_daily h
left join agency_coverage_daily a
  on a.service_date = h.service_date and a.agency_id = h.agency_id
left join poll_coverage_daily c
  on c.service_date = h.service_date;

create or replace function route_reliability_window(days int default 7)
returns table (
  route_id text,
  route_short_name text,
  mode text,
  agency_id text,
  days_measured int,
  sample_size bigint,
  on_time_pct numeric,
  severely_late_pct numeric,
  p50_delay_seconds int,
  scheduled_trips bigint,
  unobserved_trips bigint
)
language sql
stable
as $$
  select
    h.route_id,
    mode() within group (order by h.route_short_name),
    mode() within group (order by h.mode),
    mode() within group (order by h.agency_id),
    count(distinct h.service_date)::int,
    sum(h.stop_events_with_delay),
    round(100.0 * sum(h.on_time_events)   / nullif(sum(h.stop_events_with_delay), 0), 1),
    round(100.0 * sum(h.very_late_events) / nullif(sum(h.stop_events_with_delay), 0), 1),
    percentile_cont(0.5) within group (order by h.p50_delay_seconds)::int,
    sum(h.scheduled_trips),
    sum(h.unobserved_trips)
  from route_health_daily h
  join agency_coverage_daily a
    on a.service_date = h.service_date and a.agency_id = h.agency_id and a.publishes_realtime
  where h.service_date > current_date - days
    and not coalesce(h.delay_baseline_suspect, false)
  group by h.route_id
  having sum(h.stop_events_with_delay) >= 50
  order by 7 asc;
$$;
