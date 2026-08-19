-- Window aggregates for a single route and a single stop.
--
-- These exist because aggregating in the API was silently wrong, in a way worth recording:
-- the daily views withhold a percentage below the per-day sample threshold, so a route with
-- twelve events a day has a null score on every individual day. Summing those daily
-- percentages left the numerator at zero while the summed denominator crossed the
-- threshold, and published "0% on time" for routes that were running normally.
--
-- The fix is not a better sum in JavaScript. It is to aggregate the raw event counts, which
-- only the database holds, and to apply the threshold once to the total. A percentage is a
-- derived value and must never be an input to another percentage.

create or replace function stop_reliability_window(p_stop_id text, days int default 7)
returns table (
  route_id text,
  route_short_name text,
  mode text,
  days_measured int,
  sample_size bigint,
  on_time_pct numeric,
  severely_late_pct numeric,
  p50_delay_seconds int,
  meets_threshold boolean
)
language sql
stable
as $$
  select
    s.route_id,
    mode() within group (order by s.route_short_name),
    mode() within group (order by s.mode),
    count(distinct s.service_date)::int,
    sum(s.stop_events_with_delay),
    case when sum(s.stop_events_with_delay) >= 20
         then round(100.0 * sum(s.on_time_events) / sum(s.stop_events_with_delay), 1) end,
    case when sum(s.stop_events_with_delay) >= 20
         then round(100.0 * sum(s.very_late_events) / sum(s.stop_events_with_delay), 1) end,
    percentile_cont(0.5) within group (order by s.p50_delay_seconds)::int,
    sum(s.stop_events_with_delay) >= 20
  from stop_health_daily s
  where s.stop_id = p_stop_id
    and s.service_date > current_date - days
  group by s.route_id
  order by 6 asc nulls last;
$$;

create or replace function route_reliability_summary(p_route_id text, days int default 7)
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
  p90_delay_seconds int,
  scheduled_trips bigint,
  unobserved_trips bigint,
  scoreable boolean,
  withheld_reason text
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
    case when sum(h.stop_events_with_delay) >= 50 and not bool_or(coalesce(h.delay_baseline_suspect, false))
         then round(100.0 * sum(h.on_time_events) / sum(h.stop_events_with_delay), 1) end,
    case when sum(h.stop_events_with_delay) >= 50 and not bool_or(coalesce(h.delay_baseline_suspect, false))
         then round(100.0 * sum(h.very_late_events) / sum(h.stop_events_with_delay), 1) end,
    percentile_cont(0.5) within group (order by h.p50_delay_seconds)::int,
    percentile_cont(0.9) within group (order by h.p90_delay_seconds)::int,
    sum(h.scheduled_trips),
    sum(h.unobserved_trips),
    (sum(h.stop_events_with_delay) >= 50
     and not bool_or(coalesce(h.delay_baseline_suspect, false))),
    case
      when sum(h.stop_events_with_delay) < 50 then 'sample below threshold'
      when bool_or(coalesce(h.delay_baseline_suspect, false))
        then 'feed delay not measured against the timetable'
    end
  from route_health_daily h
  where h.route_id = p_route_id
    and h.service_date > current_date - days
  group by h.route_id;
$$;
