-- Backfill route_short_name / mode for observations recorded while the static feed was
-- missing. The recorder is now guarded against starting in that state.
--
-- Safe because route_id is the identity and was always recorded correctly; only the
-- human-readable label was lost. Each affected row takes the label already established for
-- the same route_id by a correctly-loaded run.

with labels as (
  select distinct on (route_id)
         route_id,
         route_short_name,
         mode
    from stop_observations
   where route_short_name is not null
   order by route_id, last_seen_at desc
)
update stop_observations o
   set route_short_name = l.route_short_name,
       mode             = l.mode
  from labels l
 where o.route_id = l.route_id
   and o.route_short_name is null;

with labels as (
  select distinct on (route_id) route_id, route_short_name, mode
    from trip_presence
   where route_short_name is not null
   order by route_id, last_seen_at desc
)
update trip_presence t
   set route_short_name = l.route_short_name,
       mode             = l.mode
  from labels l
 where t.route_id = l.route_id
   and t.route_short_name is null;
