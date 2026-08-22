-- The nightly rollup has failed with a statement timeout every night since 2026-08-20,
-- freezing the public record at the 19th. Continuous recording caused it: watch time went
-- from 13.7% to ~100%, which took stop_observations from ~330k rows a day to ~437k and the
-- table to 2M rows overall. The rollup was already close to the limit and went over.
--
-- The cost is one missing index. trip_presence is indexed on (service_date, trip_id) and
-- (service_date, route_short_name), but both compute_agency_coverage and
-- compute_route_health probe it by route_id: the first once per scheduled trip, which is
-- 24,838 sequential scans of a 98k-row table for a single date. An EXPLAIN ANALYZE of that
-- subquery alone exceeds the statement timeout.
--
-- route_id is the identity this schema chose everywhere else; route_short_name is a
-- best-effort label. The index should have followed the identity, not the label.

create index if not exists trip_presence_route_id_date_idx
  on trip_presence (service_date, route_id);

-- Headroom for the growth that is still coming. The rollups scan a whole service day and
-- that day keeps getting denser, so the default request timeout is the wrong ceiling for
-- them: they are a scheduled batch job, not an interactive query. Set on the functions
-- rather than the role so nothing else inherits a permissive limit.
alter function compute_agency_coverage(date) set statement_timeout = '5min';
alter function compute_route_health(date)    set statement_timeout = '5min';
alter function compute_stop_health(date)     set statement_timeout = '5min';
alter function compute_daily_rollups(date)   set statement_timeout = '10min';
