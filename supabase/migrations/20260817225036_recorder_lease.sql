-- Single-poller lease.
--
-- The TFI quota is 3 requests/minute pooled per key, so two recorders polling at once do
-- not halve each other's throughput, they starve each other: both sit at 429 and neither
-- records. That is easy to cause by accident — running locally while the scheduled job
-- fires, or standing up an always-on worker without first disabling the GitHub Action.
--
-- A recorder must hold this lease to poll. Acquisition is atomic, so exactly one holder
-- wins regardless of how many start simultaneously.

create table if not exists recorder_lease (
  id          int primary key default 1,
  holder      text        not null,
  acquired_at timestamptz not null default now(),
  renewed_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  constraint recorder_lease_singleton check (id = 1)
);

-- Returns true if the caller now holds the lease.
--
-- Takes it when: nobody holds one, the current holder's lease has expired, or the caller
-- already holds it (renewal). The WHERE clause does the arbitration inside a single
-- statement, so concurrent callers cannot both succeed.
create or replace function acquire_recorder_lease(p_holder text, p_ttl_seconds int default 90)
returns boolean
language plpgsql
as $$
declare
  won boolean;
begin
  insert into recorder_lease (id, holder, expires_at)
  values (1, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (id) do update
    set holder     = excluded.holder,
        renewed_at = now(),
        expires_at = excluded.expires_at,
        acquired_at = case
          when recorder_lease.holder = excluded.holder then recorder_lease.acquired_at
          else now()
        end
    where recorder_lease.expires_at < now()
       or recorder_lease.holder = excluded.holder
  returning true into won;

  return coalesce(won, false);
end;
$$;

-- Let a clean shutdown hand the lease back immediately rather than waiting for it to lapse.
create or replace function release_recorder_lease(p_holder text)
returns boolean
language plpgsql
as $$
begin
  update recorder_lease
     set expires_at = now()
   where id = 1 and holder = p_holder;
  return found;
end;
$$;
