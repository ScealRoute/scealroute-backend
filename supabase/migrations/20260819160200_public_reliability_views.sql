-- The public record.
--
-- Three rules, and every one of them exists because breaking it produces a number an
-- operator can demolish in one sentence:
--
--   1. The denominator travels with the score, always.
--   2. Nothing is scored below the sample threshold. Silence beats a confident figure
--      built on nine data points.
--   3. Nothing is scored for an operator that publishes no realtime feed. We have never
--      observed a single TFI Local Link departure and never will through this feed; a
--      reliability figure for one would be fabricated.
--
-- Rule 3 is the new one, and it is not a small carve-out: 81 of 87 operators and 20.3% of
-- all scheduled trips in the country sit outside realtime coverage.

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

  case when h.stop_events_with_delay >= 50
       then round(100.0 * h.on_time_events / nullif(h.stop_events_with_delay, 0), 1) end
                                                as on_time_pct,
  case when h.stop_events_with_delay >= 50
       then round(100.0 * h.very_late_events / nullif(h.stop_events_with_delay, 0), 1) end
                                                as severely_late_pct,

  h.p50_delay_seconds,
  h.p90_delay_seconds,
  h.cancelled_trips,

  -- Upper bound on non-appearance, not a cancellation rate. Published only alongside the
  -- watch time that bounds it, so it cannot be quoted on its own without the caveat.
  h.unobserved_trips,
  c.watched_pct                                 as day_watched_pct,
  c.longest_gap_seconds                         as longest_watch_gap_seconds,

  h.stop_events_with_delay >= 50                as meets_threshold,
  coalesce(a.publishes_realtime, false)         as operator_publishes_realtime,
  (h.stop_events_with_delay >= 50 and coalesce(a.publishes_realtime, false))
                                                as scoreable
from route_health_daily h
left join agency_coverage_daily a
  on a.service_date = h.service_date and a.agency_id = h.agency_id
left join poll_coverage_daily c
  on c.service_date = h.service_date;

-- Per-stop record. The threshold is lower than the route one because a single stop sees a
-- fraction of a route's events; 20 is roughly a fortnight of a half-hourly service.
create view stop_health_public as
select
  service_date,
  stop_id,
  route_id,
  route_short_name,
  mode,
  stop_events                                   as observations,
  stop_events_with_delay                        as sample_size,
  case when stop_events_with_delay >= 20
       then round(100.0 * on_time_events / nullif(stop_events_with_delay, 0), 1) end
                                                as on_time_pct,
  case when stop_events_with_delay >= 20
       then round(100.0 * very_late_events / nullif(stop_events_with_delay, 0), 1) end
                                                as severely_late_pct,
  p50_delay_seconds,
  p90_delay_seconds,
  stop_events_with_delay >= 20                  as meets_threshold
from stop_health_daily;

-- What the country's transport actually did, over a window rather than a single day.
--
-- Aggregating events rather than averaging daily percentages: a route with 4,000 events on
-- Monday and 40 on Sunday must not have Sunday count equally, which is what averaging the
-- two rates would do.
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
  group by h.route_id
  having sum(h.stop_events_with_delay) >= 50
  order by 7 asc;
$$;
