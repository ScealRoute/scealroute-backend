-- Nightly rollup: raw observations -> publishable route health.
--
-- Kept separate from collection on purpose. The thresholds below are judgement calls and
-- will be argued about; when they change, this can be re-run over the raw data. Collection
-- cannot be re-run, which is why the recorder stores signal and this file stores opinion.
--
-- Thresholds follow common transit practice: a service is "on time" from 1 minute early to
-- 5 minutes late. Anything beyond 10 minutes late is counted separately, because a single
-- 40-minute failure and eight 6-minute delays are not the same passenger experience and
-- should not average into the same number.
--
-- Usage: select * from compute_route_health('2026-08-16');

create or replace function compute_route_health(target_date date)
returns int
language plpgsql
as $$
declare
  affected int;
begin
  delete from route_health_daily where service_date = target_date;

  insert into route_health_daily (
    service_date, route_short_name, mode,
    trips_seen, stop_events, stop_events_with_delay,
    on_time_events, late_events, early_events, very_late_events,
    avg_delay_seconds, p50_delay_seconds, p90_delay_seconds, max_delay_seconds,
    cancelled_trips
  )
  select
    o.service_date,
    o.route_short_name,
    max(o.mode)                                                as mode,
    count(distinct o.trip_id)                                  as trips_seen,
    count(*)                                                   as stop_events,
    count(o.last_delay_seconds)                                as stop_events_with_delay,

    count(*) filter (where o.last_delay_seconds between -60 and 300)  as on_time_events,
    count(*) filter (where o.last_delay_seconds > 300)                as late_events,
    count(*) filter (where o.last_delay_seconds < -60)                as early_events,
    count(*) filter (where o.last_delay_seconds > 600)                as very_late_events,

    round(avg(o.last_delay_seconds)::numeric, 1)               as avg_delay_seconds,
    percentile_cont(0.5) within group (order by o.last_delay_seconds)::int as p50_delay_seconds,
    percentile_cont(0.9) within group (order by o.last_delay_seconds)::int as p90_delay_seconds,
    max(o.last_delay_seconds)                                  as max_delay_seconds,

    (select count(distinct t.trip_id) from trip_presence t
      where t.service_date = o.service_date
        and t.route_short_name = o.route_short_name
        and t.schedule_relationship = 3)                       as cancelled_trips
  from stop_observations o
  where o.service_date = target_date
    and o.route_short_name is not null
  group by o.service_date, o.route_short_name;

  get diagnostics affected = row_count;
  return affected;
end;
$$;


-- Publishable view.
--
-- Two rules make this safe to put in front of the public:
--   1. The denominator travels with the score. A percentage without its sample size is
--      not a defensible claim, and this is the number an operator will dispute first.
--   2. Routes below the observation threshold return null rather than a score. Silence
--      is better than a confident figure derived from nine data points.
create or replace view route_health_public as
select
  service_date,
  route_short_name,
  mode,
  trips_seen,
  stop_events                                   as observations,
  case
    when stop_events_with_delay >= 50
    then round(100.0 * on_time_events / nullif(stop_events_with_delay, 0), 1)
  end                                           as on_time_pct,
  case
    when stop_events_with_delay >= 50
    then round(100.0 * very_late_events / nullif(stop_events_with_delay, 0), 1)
  end                                           as severely_late_pct,
  stop_events_with_delay                        as sample_size,
  p50_delay_seconds,
  p90_delay_seconds,
  cancelled_trips,
  stop_events_with_delay >= 50                  as meets_threshold
from route_health_daily;
