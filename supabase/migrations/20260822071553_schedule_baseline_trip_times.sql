-- Give every scheduled trip a time window, so that "never appeared in the realtime feed"
-- becomes a testable claim instead of an accusation.
--
-- On 2026-08-21, 877 scheduled trips nationally were never observed. 825 of them are Bus
-- Éireann; Dublin Bus missed 2 of 8,048. Decomposed by route, Bus Éireann splits into 8
-- routes that join at 0% and 11 that join under half (305 trips, an identifier mismatch
-- rather than absent service), 86 that join perfectly, and 83 with scattered misses
-- totalling 520 trips. Only that last group is a candidate for a trip that did not run.
--
-- 520 trips is 8.8% of the operator's day against Dublin Bus's 0.02%. Published as a
-- cancellation rate that is a serious allegation, and the far likelier explanation is that
-- the feed stops describing trips at some times of day. Bus Éireann would answer it by
-- pointing at their own feed, and they would be right to, because nothing recorded here
-- currently rules it out.
--
-- A time window per trip does rule on it. Misses clustered at the edges of the service day
-- are a feed that falls silent early and starts late; misses spread evenly across the day
-- are service that was scheduled and not run. The distinction is the whole difference
-- between a reliability record and a rumour.

-- Seconds from the start of the service day, not clock times. GTFS runs past midnight
-- rather than wrapping, and departures in the current feed reach hour 32, so 25:30:00 is
-- an ordinary value that `time` would reject. Seconds also sort correctly: a 00:40 night
-- service stays after the 23:50 ahead of it instead of jumping to the head of the day.
--
-- Nullable throughout. Every baseline built before this migration has no times, and a
-- date built without stop_times.txt still has none; zero would read as midnight.
alter table schedule_baseline add column if not exists first_departure_sec int;
alter table schedule_baseline add column if not exists last_arrival_sec    int;

-- Provenance, because the times and the trips they annotate can come from different
-- published feeds. Each existing baseline was built from the feed current on its own date
-- (six dates, six different feed_versions) and NTA does not publish an archive, so times
-- backfilled onto a past date necessarily come from a later feed, matched by trip_id.
-- That is a sound way to date a trip and an unsound way to decide whether it existed, so
-- the two feed versions are recorded separately rather than collapsed into one column.
-- Without this the baseline stops describing its own provenance, which is the failure this
-- table was built to prevent.
alter table schedule_baseline_runs add column if not exists times_feed_version text;
alter table schedule_baseline_runs add column if not exists trips_with_times   int;

comment on column schedule_baseline.first_departure_sec is
  'Departure from the first stop, seconds from the start of the service day. May exceed 86400.';
comment on column schedule_baseline.last_arrival_sec is
  'Arrival at the last stop, seconds from the start of the service day. May exceed 86400.';
comment on column schedule_baseline_runs.times_feed_version is
  'feed_version of the static feed that supplied first_departure_sec/last_arrival_sec. Differs from feed_version when times were attached to a baseline built earlier.';
comment on column schedule_baseline_runs.trips_with_times is
  'Rows in this date''s baseline that carry a time window. Below scheduled_trips when the times feed no longer lists some trip_ids.';
