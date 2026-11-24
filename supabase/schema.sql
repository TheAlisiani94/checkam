-- CheckAm backend for Supabase (free tier is enough to start).
-- Run this whole file once in Supabase > SQL Editor > New query > Run.
--
-- Design: the public app (anon key) can NOT read or write tables directly.
-- It can only call the functions below, so nobody can download the list of
-- subscribers or everyone's scans. You read everything from the Supabase dashboard.

create extension if not exists pgcrypto;

-- Every real scan (no names, no phone numbers; device_id is a random id made by the app)
create table if not exists scans (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,            -- "GTIN|serial"
  gtin        text, serial text, lot text, exp date,
  city        text, state text,
  level       text check (level in ('ok','warn','bad')),
  device_id   text not null,
  created_at  timestamptz not null default now()
);
create index if not exists scans_key_idx on scans(key);
create index if not exists scans_created_idx on scans(created_at desc);

-- Reports people send from a result screen
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  gtin text, serial text, lot text, note text, seller text, city text, state text,
  device_id text, reviewed boolean not null default false,
  created_at timestamptz not null default now()
);

-- People who chose to sign up for alerts
create table if not exists subscribers (
  id uuid primary key default gen_random_uuid(),
  name text, contact text not null, state text, device_id text,
  token uuid not null default gen_random_uuid() unique,  -- used to unsubscribe
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists subscribers_contact_idx on subscribers(lower(contact));

-- Lock the tables: no direct access for the public key
alter table scans enable row level security;
alter table reports enable row level security;
alter table subscribers enable row level security;
revoke all on scans, reports, subscribers from anon, authenticated;

-- How many OTHER devices scanned this exact serial, and in which towns
create or replace function check_serial(p_key text, p_device text)
returns json language sql security definer set search_path = public as $$
  select json_build_object(
    'others', count(distinct device_id),
    'cities', coalesce(json_agg(distinct lower(city)) filter (where coalesce(city,'') <> ''), '[]'::json))
  from scans where key = p_key and device_id <> p_device;
$$;

-- Save a scan (max 30 per device per 10 minutes, to slow down abuse)
create or replace function log_scan(p_key text, p_gtin text, p_serial text, p_lot text, p_exp date,
  p_city text, p_state text, p_level text, p_device text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from scans where device_id = p_device and created_at > now() - interval '10 minutes') >= 30 then
    return;
  end if;
  insert into scans(key, gtin, serial, lot, exp, city, state, level, device_id)
  values (left(p_key,80), left(p_gtin,14), left(p_serial,40), left(p_lot,40), p_exp,
          left(p_city,60), left(p_state,40), p_level, left(p_device,64));
end $$;

create or replace function add_report(p_gtin text, p_serial text, p_lot text, p_note text, p_seller text,
  p_city text, p_state text, p_device text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from reports where device_id = p_device and created_at > now() - interval '1 hour') >= 10 then
    return;
  end if;
  insert into reports(gtin, serial, lot, note, seller, city, state, device_id)
  values (left(p_gtin,14), left(p_serial,40), left(p_lot,40), left(p_note,500), left(p_seller,100),
          left(p_city,60), left(p_state,40), left(p_device,64));
end $$;

-- Sign up (or update an existing sign-up with the same contact). Returns the unsubscribe token.
create or replace function subscribe(p_name text, p_contact text, p_state text, p_device text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  insert into subscribers(name, contact, state, device_id)
  values (left(p_name,60), left(p_contact,120), left(p_state,40), left(p_device,64))
  on conflict ((lower(contact))) do update set name = excluded.name, state = excluded.state, active = true
  returning token into t;
  return t;
end $$;

create or replace function unsubscribe(p_token uuid)
returns void language sql security definer set search_path = public as $$
  update subscribers set active = false where token = p_token;
$$;

-- Public alert feed: packs flagged in the last 14 days (no device ids, no contacts)
create or replace function recent_flags()
returns table(reason text, gtin text, lot text, city text, state text, created_at timestamptz)
language sql security definer set search_path = public as $$
  select * from (
    select 'Code flagged by a scan'::text, s.gtin, s.lot, s.city, s.state, s.created_at
      from scans s where s.level = 'bad' and s.created_at > now() - interval '14 days'
    union all
    select 'Reported by a user'::text, r.gtin, r.lot, r.city, r.state, r.created_at
      from reports r where r.created_at > now() - interval '14 days'
  ) f order by 6 desc limit 30;
$$;

grant execute on function check_serial, log_scan, add_report, subscribe, unsubscribe, recent_flags to anon;
