-- CheckAm update 003: searchable, filterable alerts with paging.
-- Run once in Supabase > SQL Editor after 002. Safe to run again.

create index if not exists reports_created_idx on reports(created_at desc);
create index if not exists reports_gtin_idx on reports(gtin);

-- p_query: product name, maker, batch or product number (any part)
-- p_state: one state name, or '' for all of Nigeria
-- p_days:  30, 180 ... or 0 for all time
create or replace function search_alerts(p_query text default '', p_state text default '', p_days int default 30,
  p_limit int default 20, p_offset int default 0)
returns json language sql stable security definer set search_path = public as $$
  with params as (
    select lower(trim(coalesce(p_query,''))) as q,
           regexp_replace(coalesce(p_query,''), '[^0-9]', '', 'g') as qd,
           trim(coalesce(p_state,'')) as st,
           case when coalesce(p_days,0) > 0 then now() - make_interval(days => p_days) else '-infinity'::timestamptz end as since
  ),
  a as (
    select gtin, coalesce(lot,'') as lot, product, maker, exp, issues, made_ill, city, state, created_at, 'report' as kind
      from reports, params where created_at > params.since and (coalesce(gtin,'') <> '' or coalesce(product,'') <> '')
    union all
    select gtin, coalesce(lot,''), null, null, exp, '{}'::text[], false, city, state, created_at, 'scan'
      from scans, params where level = 'bad' and created_at > params.since
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
      array_remove(array_agg(distinct nullif(trim(state),'')), null) as states,
      min(created_at) as first_seen, max(created_at) as last_seen
    from a group by gtin, lot
  ),
  -- If this batch has no name yet, borrow the latest name reported for the same product number
  n as (
    select g.*,
      coalesce(g.product, (select r.product from reports r where r.gtin = g.gtin and coalesce(r.product,'') <> '' order by r.created_at desc limit 1)) as pname,
      coalesce(g.maker, (select r.maker from reports r where r.gtin = g.gtin and coalesce(r.maker,'') <> '' order by r.created_at desc limit 1)) as pmaker
    from g
  ),
  f as (
    select n.* from n, params p
    where (p.st = '' or p.st = any(n.states))
      and (p.q = ''
           or position(p.q in lower(coalesce(n.pname,''))) > 0
           or position(p.q in lower(coalesce(n.pmaker,''))) > 0
           or position(p.q in lower(n.lot)) > 0
           or (length(p.qd) >= 4 and position(p.qd in coalesce(n.gtin,'')) > 0))
  )
  select json_build_object(
    'total', (select count(*) from f),
    'items', coalesce((select json_agg(json_build_object(
        'gtin', x.gtin, 'lot', nullif(x.lot,''), 'product', x.pname, 'maker', x.pmaker, 'exp', x.exp,
        'reports', x.reports, 'flagged_scans', x.flagged_scans, 'made_ill', x.made_ill,
        'places', x.places, 'states', x.states, 'first_seen', x.first_seen, 'last_seen', x.last_seen,
        'issues', (select coalesce(json_agg(json_build_object('issue', i, 'n', c) order by c desc), '[]'::json)
                   from (select i, count(*) c from a a2, unnest(a2.issues) i
                         where a2.gtin is not distinct from x.gtin and a2.lot = x.lot group by i) q)
      ) order by x.last_seen desc)
      from (select * from f order by last_seen desc
            limit least(greatest(coalesce(p_limit,20),1),50) offset greatest(coalesce(p_offset,0),0)) x), '[]'::json));
$$;

grant execute on function search_alerts to anon;
