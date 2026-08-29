-- Refuse to publish a day the recorder did not watch.
--
-- Between 27 and 29 August the recorder lost most of the day: watch time fell from 96.7%
-- to 42.3% and the longest blind spot went from 2.5 minutes to 7 hours 24 minutes, because
-- GitHub stopped delivering the scheduled triggers. Four daily recorder runs became two,
-- and recorder-standby.yml, which exists to catch exactly that, is on a */15 cron and was
-- itself delivered about three times a day.
--
-- The record reported this as a service collapse. Unobserved trips went from 1,154 on the
-- 26th to 9,706 on the 29th, and 728 route-days across those three days were still flagged
-- scoreable. The give-away that it was the instrument and not the service: every operator
-- fell together, Dublin Bus 100% -> 77% -> 63% -> 38.5%, with Go-Ahead, Irish Rail and LUAS
-- moving in step. Operators do not fail in formation.
--
-- The view already carried day_watched_pct and longest_gap_seconds, but only as columns for
-- a reader to notice. Nothing acted on them. That is the same mistake as publishing a
-- percentage without its sample size: the caveat has to be enforced by the query, because a
-- number that has escaped into a headline no longer travels with its footnote.
--
-- Two different gates, because two different claims break at different rates.
--
--   Punctuality is a sample. A day that is 60% watched still yields real delay observations
--   for the hours it saw, so the existing sample-size threshold mostly holds it up. What
--   ruins it is a hole: a single missing rush hour biases the day without reducing the
--   sample below any threshold. So punctuality is gated on the SHAPE of the coverage, the
--   longest gap, not on the total.
--
--   Trip counts are a census. unobserved_trips is scheduled minus seen, so every unwatched
--   minute inflates it directly and only ever in one direction. A census needs the whole
--   day, so those counts additionally wait for the service day to close.
--
-- cancelled_trips is withheld with them. It is an honest count of cancellations actually
-- observed, but a reader will take it as the day's cancellation total, and on a half-watched
-- day it is an undercount: it fell to 124 on the 29th against 484 on the 26th, which would
-- read as an operator improving on precisely the days we could see least.

create or replace view route_health_public
with (security_invoker = on) as
with cov as (
  select
    h.service_date,
    -- The service day runs to 04:00 the following morning, the same boundary the recorder
    -- uses to assign service_date. A census taken before then is counting a day still in
    -- progress.
    (now() at time zone 'Europe/Dublin') >= ((h.service_date + 1)::timestamp + interval '4 hours')
                                                              as day_complete,
    -- A missing row in poll_coverage_daily means no successful poll all day, so the absent
    -- case has to fail rather than default to permissive.
    coalesce(c.longest_gap_seconds, 86400) <= 3600            as gap_ok,
    coalesce(c.watched_pct, 0) >= 90                          as watched_enough,
    c.watched_pct,
    c.longest_gap_seconds
  from route_health_daily h
  left join poll_coverage_daily c on c.service_date = h.service_date
  group by h.service_date, c.watched_pct, c.longest_gap_seconds
)
select
  h.service_date,
  h.route_id,
  h.route_short_name,
  h.mode,
  h.agency_id,
  h.trips_seen,
  h.scheduled_trips,
  h.stop_events                                               as observations,
  h.stop_events_with_delay                                    as sample_size,
  case
    when h.stop_events_with_delay >= 50
     and not coalesce(h.delay_baseline_suspect, false)
     and cov.gap_ok
    then round(100.0 * h.on_time_events::numeric / nullif(h.stop_events_with_delay, 0)::numeric, 1)
  end                                                         as on_time_pct,
  case
    when h.stop_events_with_delay >= 50
     and not coalesce(h.delay_baseline_suspect, false)
     and cov.gap_ok
    then round(100.0 * h.very_late_events::numeric / nullif(h.stop_events_with_delay, 0)::numeric, 1)
  end                                                         as severely_late_pct,
  h.p50_delay_seconds,
  h.p90_delay_seconds,
  -- Census figures: whole day, well watched, or nothing.
  case when cov.day_complete and cov.gap_ok and cov.watched_enough
       then h.cancelled_trips end                             as cancelled_trips,
  case when cov.day_complete and cov.gap_ok and cov.watched_enough
       then h.unobserved_trips end                            as unobserved_trips,
  cov.watched_pct                                             as day_watched_pct,
  cov.longest_gap_seconds                                     as longest_watch_gap_seconds,
  h.stop_events_with_delay >= 50                              as meets_threshold,
  coalesce(a.publishes_realtime, false)                       as operator_publishes_realtime,
  coalesce(h.delay_baseline_suspect, false)                   as delay_baseline_suspect,
  h.stop_events_with_delay >= 50
    and coalesce(a.publishes_realtime, false)
    and not coalesce(h.delay_baseline_suspect, false)
    and cov.gap_ok                                            as scoreable,
  case
    when not coalesce(a.publishes_realtime, false) then 'operator publishes no realtime feed'
    when not cov.gap_ok then 'day not observed continuously enough to score'
    when h.stop_events_with_delay < 50 then 'sample below threshold'
    when coalesce(h.delay_baseline_suspect, false) then 'feed delay not measured against the timetable'
  end                                                         as withheld_reason,
  -- Appended rather than inserted, so existing consumers keep their column positions.
  cov.day_complete and cov.gap_ok and cov.watched_enough      as trip_counts_published,
  case
    when not cov.day_complete then 'service day still in progress'
    when not cov.gap_ok then 'longest blind spot exceeds one hour'
    when not cov.watched_enough then 'less than 90% of the day watched'
  end                                                         as trip_counts_withheld_reason
from route_health_daily h
left join agency_coverage_daily a
  on a.service_date = h.service_date and a.agency_id = h.agency_id
left join cov on cov.service_date = h.service_date;

-- The per-stop view carries no trip counts, so only the punctuality gate applies. It did
-- not join poll coverage at all, which meant a stop's score on a blind day was published
-- with nothing at all to indicate the day had holes in it.
create or replace view stop_health_public
with (security_invoker = on) as
select
  s.service_date,
  s.stop_id,
  s.route_id,
  s.route_short_name,
  s.mode,
  s.stop_events                                               as observations,
  s.stop_events_with_delay                                    as sample_size,
  case
    when s.stop_events_with_delay >= 20
     and coalesce(c.longest_gap_seconds, 86400) <= 3600
    then round(100.0 * s.on_time_events::numeric / nullif(s.stop_events_with_delay, 0)::numeric, 1)
  end                                                         as on_time_pct,
  case
    when s.stop_events_with_delay >= 20
     and coalesce(c.longest_gap_seconds, 86400) <= 3600
    then round(100.0 * s.very_late_events::numeric / nullif(s.stop_events_with_delay, 0)::numeric, 1)
  end                                                         as severely_late_pct,
  s.p50_delay_seconds,
  s.p90_delay_seconds,
  s.stop_events_with_delay >= 20                              as meets_threshold,
  c.watched_pct                                               as day_watched_pct,
  c.longest_gap_seconds                                       as longest_watch_gap_seconds,
  case
    when coalesce(c.longest_gap_seconds, 86400) > 3600 then 'day not observed continuously enough to score'
    when s.stop_events_with_delay < 20 then 'sample below threshold'
  end                                                         as withheld_reason
from stop_health_daily s
left join poll_coverage_daily c on c.service_date = s.service_date;

comment on view route_health_public is
  'Per-route daily reliability, with every claim gated on whether the day was actually observed. Punctuality is withheld when the longest blind spot exceeds an hour; trip counts additionally require a closed service day that was 90% watched.';
comment on view stop_health_public is
  'Per-stop per-route daily punctuality. Withheld when the sample is thin or the day had a blind spot longer than an hour.';
