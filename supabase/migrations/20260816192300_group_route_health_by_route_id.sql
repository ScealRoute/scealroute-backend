-- Group route health by the raw feed route_id, not by a parsed short name.
--
-- The parsed short name is a label produced by pattern-matching an undocumented id format,
-- and it is not reliable enough to be an identity. The raw route_id is always present and
-- always stable, so it is the correct grouping key. Naming can be recomputed later, and
-- will become authoritative once the static GTFS feed is refreshed (the committed snapshot
-- is from December 2025 and its trip ids no longer join to the live feed at all).

drop view if exists route_health_public;
drop table if exists route_health_daily;

create table route_health_daily (
  service_date        date not null,
  route_id            text not null,          -- raw feed id, the identity
  route_short_name    text,                   -- best-effort label, recomputable
  mode                text,

  trips_seen          int  not null,
  stop_events         int  not null,
  stop_events_with_delay int not null,

  on_time_events      int  not null,
  late_events         int  not null,
  early_events        int  not null,
  very_late_events    int  not null,

  avg_delay_seconds   numeric,
  p50_delay_seconds   int,
  p90_delay_seconds   int,
  max_delay_seconds   int,

  cancelled_trips     int not null default 0,

  computed_at         timestamptz not null default now(),
  primary key (service_date, route_id)
);

create index if not exists stop_observations_route_id_date_idx
  on stop_observations (service_date, route_id);

create or replace function compute_route_health(target_date date)
returns int
language plpgsql
as $$
declare
  affected int;
begin
  delete from route_health_daily where service_date = target_date;

  insert into route_health_daily (
    service_date, route_id, route_short_name, mode,
    trips_seen, stop_events, stop_events_with_delay,
    on_time_events, late_events, early_events, very_late_events,
    avg_delay_seconds, p50_delay_seconds, p90_delay_seconds, max_delay_seconds,
    cancelled_trips
  )
  select
    o.service_date,
    o.route_id,
    mode() within group (order by o.route_short_name)          as route_short_name,
    mode() within group (order by o.mode)                      as mode,
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
        and t.schedule_relationship = 3)
  from stop_observations o
  where o.service_date = target_date
    and o.route_id is not null
  group by o.service_date, o.route_id;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create view route_health_public as
select
  service_date,
  route_id,
  route_short_name,
  mode,
  trips_seen,
  stop_events                                   as observations,
  case when stop_events_with_delay >= 50
       then round(100.0 * on_time_events / nullif(stop_events_with_delay, 0), 1) end
                                                as on_time_pct,
  case when stop_events_with_delay >= 50
       then round(100.0 * very_late_events / nullif(stop_events_with_delay, 0), 1) end
                                                as severely_late_pct,
  stop_events_with_delay                        as sample_size,
  p50_delay_seconds,
  p90_delay_seconds,
  cancelled_trips,
  stop_events_with_delay >= 50                  as meets_threshold
from route_health_daily;
