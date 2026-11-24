-- CheckAm update 002: separate email / WhatsApp, richer reports, grouped alerts.
-- Run once in Supabase > SQL Editor after schema.sql. Safe to run again.

-- Sign-ups: separate email and phone (old "contact" column kept for earlier sign-ups)
alter table subscribers add column if not exists email text;
alter table subscribers add column if not exists phone text;
alter table subscribers alter column contact drop not null;
create unique index if not exists subscribers_email_idx on subscribers(lower(email)) where email is not null;
create unique index if not exists subscribers_phone_idx on subscribers(phone) where phone is not null;

-- Reports: product details and tick-box issues
alter table reports add column if not exists product text;
alter table reports add column if not exists maker text;
alter table reports add column if not exists exp date;
alter table reports add column if not exists issues text[] not null default '{}';
alter table reports add column if not exists made_ill boolean not null default false;

-- Sign up with email and/or WhatsApp. Updates an existing sign-up that matches either.
create or replace function subscribe_v2(p_name text, p_email text, p_phone text, p_state text, p_device text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t uuid;
  e text := nullif(lower(trim(coalesce(p_email,''))), '');
  ph text := nullif(regexp_replace(coalesce(p_phone,''), '[^0-9+]', '', 'g'), '');
begin
  if e is null and ph is null then raise exception 'email or phone required'; end if;
  if e is not null and e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email'; end if;
  if ph is not null and length(ph) not between 10 and 16 then raise exception 'invalid phone'; end if;
  select token into t from subscribers
    where (e is not null and lower(email) = e) or (ph is not null and phone = ph) limit 1;
  if t is not null then
    -- Fill in the other contact only if no different sign-up already uses it
    update subscribers set name = left(p_name,60),
      email = case when e is not null and not exists (select 1 from subscribers o where lower(o.email) = e and o.token <> t) then e else email end,
      phone = case when ph is not null and not exists (select 1 from subscribers o where o.phone = ph and o.token <> t) then ph else phone end,
      state = left(p_state,40), active = true where token = t;
    return t;
  end if;
  insert into subscribers(name, email, phone, state, device_id)
  values (left(p_name,60), left(e,120), left(ph,16), left(p_state,40), left(p_device,64))
  returning token into t;
  return t;
end $$;

-- Report with product details. Issues are limited to the app's tick-box list.
create or replace function add_report_v2(p_gtin text, p_serial text, p_lot text, p_exp date, p_product text, p_maker text,
  p_issues text[], p_made_ill boolean, p_note text, p_seller text, p_city text, p_state text, p_device text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from reports where device_id = p_device and created_at > now() - interval '1 hour') >= 10 then
    return;
  end if;
  insert into reports(gtin, serial, lot, exp, product, maker, issues, made_ill, note, seller, city, state, device_id)
  values (left(p_gtin,14), left(p_serial,40), left(p_lot,40), p_exp, left(p_product,80), left(p_maker,80),
          coalesce((select array_agg(distinct i) from unnest(coalesce(p_issues,'{}')) i
                    where i in ('print','spelling','seal','price','date','different','no_effect','ill')), '{}'),
          coalesce(p_made_ill,false) or 'ill' = any(coalesce(p_issues,'{}')),
          left(p_note,500), left(p_seller,100), left(p_city,60), left(p_state,40), left(p_device,64));
end $$;

-- Public alerts, grouped by product and batch (last 30 days).
-- Shows no device ids, contacts, shop names or free-text notes.
create or replace function recent_alerts()
returns json language sql security definer set search_path = public as $$
  with a as (
    select gtin, coalesce(lot,'') as lot, product, maker, exp, issues, made_ill, city, state, created_at, 'report' as kind
      from reports where created_at > now() - interval '30 days'
    union all
    select gtin, coalesce(lot,''), null, null, exp, '{}'::text[], false, city, state, created_at, 'scan'
      from scans where level = 'bad' and created_at > now() - interval '30 days'
  ),
  g as (
    select gtin, lot,
      (array_agg(product order by created_at desc) filter (where coalesce(product,'') <> ''))[1] as product,
      (array_agg(maker order by created_at desc) filter (where coalesce(maker,'') <> ''))[1] as maker,
      max(exp) as exp,
      count(*) filter (where kind = 'report') as reports,
      count(*) filter (where kind = 'scan') as flagged_scans,
      count(*) filter (where made_ill) as made_ill,
      array_remove(array_agg(distinct nullif(concat_ws(', ', nullif(trim(city),''), nullif(trim(state),'')), '')), null) as places,
      min(created_at) as first_seen, max(created_at) as last_seen
    from a group by gtin, lot
  )
  select coalesce(json_agg(json_build_object(
      'gtin', g.gtin, 'lot', nullif(g.lot,''), 'product', g.product, 'maker', g.maker, 'exp', g.exp,
      'reports', g.reports, 'flagged_scans', g.flagged_scans, 'made_ill', g.made_ill, 'places', g.places,
      'first_seen', g.first_seen, 'last_seen', g.last_seen,
      'issues', (select coalesce(json_agg(json_build_object('issue', i, 'n', n) order by n desc), '[]'::json)
                 from (select i, count(*) n from a a2, unnest(a2.issues) i
                       where a2.gtin is not distinct from g.gtin and a2.lot = g.lot group by i) q)
    ) order by g.last_seen desc), '[]'::json)
  from (select * from g order by last_seen desc limit 30) g;
$$;

grant execute on function subscribe_v2, add_report_v2, recent_alerts to anon;
