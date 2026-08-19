-- Close public write access to the recorder tables.
--
-- Every table added for the recorder and the rollups was created without row level
-- security. Postgres grants in this project give the `anon` role DELETE, INSERT, UPDATE,
-- TRUNCATE and SELECT on all public tables, with RLS as the only gate. With RLS off, that
-- gate is open, and the publishable key ships inside the mobile app, so it is public by
-- design.
--
-- Concretely, before this migration anyone holding that key could:
--
--   - DELETE FROM stop_observations. That is 900,000+ observations which cannot be
--     backfilled at any price: GTFS-RT is a live-only feed with no historical archive, so
--     a row lost is a measurement that no longer exists anywhere. It is the entire asset.
--   - Seize or corrupt recorder_lease, which is the single-poller arbiter, and stop the
--     recorder from ever polling again.
--   - Rewrite route_health_daily or stop_health_daily, forging the reliability record
--     itself. The whole product claim is that this record is evidence; a record anyone can
--     edit is not evidence.
--
-- The six older tables (users, reports, alerts, journeys, stop_reviews, traffic) already
-- had RLS enabled with no policies, which denies anon outright. This brings the rest in
-- line with them.
--
-- No policies are added. The API and the recorder both connect with the secret key, whose
-- service role bypasses RLS, so nothing that exists today loses access. Read access for a
-- future public reliability page is a deliberate, separate decision: it should grant SELECT
-- on the three published rollup tables only, never on the raw observations or the lease.

alter table stop_observations      enable row level security;
alter table trip_presence          enable row level security;
alter table feed_polls             enable row level security;
alter table recorder_lease         enable row level security;
alter table schedule_baseline      enable row level security;
alter table schedule_baseline_runs enable row level security;
alter table route_health_daily     enable row level security;
alter table stop_health_daily      enable row level security;
alter table agency_coverage_daily  enable row level security;

-- The published views ran as SECURITY DEFINER, the Postgres default, which means they
-- enforce the permissions of whoever created them rather than whoever queries them. That
-- would let a view hand out exactly the access the RLS above just withdrew. Views should
-- never widen their caller's reach.
alter view route_health_public set (security_invoker = on);
alter view stop_health_public  set (security_invoker = on);
alter view poll_coverage_daily set (security_invoker = on);

-- Pin the resolution path for every function this project defines. A mutable search_path
-- lets a caller who can create objects shadow a referenced table or operator and have the
-- function run against theirs instead.
alter function compute_agency_coverage(date)          set search_path = public, pg_temp;
alter function compute_route_health(date)             set search_path = public, pg_temp;
alter function compute_stop_health(date)              set search_path = public, pg_temp;
alter function compute_daily_rollups(date)            set search_path = public, pg_temp;
alter function route_reliability_window(int)          set search_path = public, pg_temp;
alter function route_reliability_summary(text, int)   set search_path = public, pg_temp;
alter function stop_reliability_window(text, int)     set search_path = public, pg_temp;
alter function acquire_recorder_lease(text, int)      set search_path = public, pg_temp;
alter function release_recorder_lease(text)           set search_path = public, pg_temp;
alter function gtfs_route_stem(text)                  set search_path = public, pg_temp;
