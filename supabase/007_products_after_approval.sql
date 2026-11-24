-- CheckAm 007: approved manufacturers add new products themselves.
-- A product whose GTIN starts with the company's verified GS1 prefix is live at once;
-- any other GTIN waits for an admin to check it against GS1 records before it can show Genuine.

alter table mfr_products add column if not exists review text not null default 'ok';
alter table mfr_products drop constraint if exists mfr_products_review_chk;
alter table mfr_products add constraint mfr_products_review_chk check (review in ('ok','pending','rejected'));

-- Does a 14-digit GTIN carry this company prefix?
create or replace function gtin_has_prefix(p_gtin text, p_prefix text) returns boolean
language sql immutable as $$
  select coalesce(length(regexp_replace(p_prefix, '\D', '', 'g')) >= 6, false)
     and (substr(p_gtin, 2) like regexp_replace(p_prefix, '\D', '', 'g') || '%'
          or p_gtin like regexp_replace(p_prefix, '\D', '', 'g') || '%');
$$;

create or replace function gtin_valid(p_gtin text) returns boolean
language plpgsql immutable as $$
declare s int := 0; i int;
begin
  if p_gtin !~ '^\d{14}$' then return false; end if;
  for i in 1..13 loop s := s + substr(p_gtin, i, 1)::int * case when i % 2 = 1 then 3 else 1 end; end loop;
  return (10 - s % 10) % 10 = substr(p_gtin, 14, 1)::int;
end $$;

create or replace function add_product(p_name text, p_strength text, p_form text, p_pack text, p_gtin text, p_nafdac text, p_nafdac_exp date)
returns json language plpgsql security definer set search_path = public as $$
declare m manufacturers; g text; rv text; r mfr_products;
begin
  select * into m from manufacturers where id = my_manufacturer_id();
  if m.id is null or m.status <> 'approved' then raise exception 'Only verified manufacturers can add products here'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Enter the product name'; end if;
  if coalesce(trim(p_nafdac),'') = '' then raise exception 'Enter the NAFDAC registration number'; end if;
  g := lpad(regexp_replace(coalesce(p_gtin,''), '\D', '', 'g'), 14, '0');
  if not gtin_valid(g) then raise exception 'That product number (GTIN) is not valid. Check the digits.'; end if;
  if exists (select 1 from mfr_products where gtin = g and manufacturer_id = m.id) then raise exception 'You already have a product with this GTIN'; end if;
  if exists (select 1 from mfr_products p join manufacturers x on x.id = p.manufacturer_id where p.gtin = g and x.status = 'approved' and p.review = 'ok') then
    raise exception 'This GTIN belongs to another verified company. Contact CheckAm if this is wrong.';
  end if;
  rv := case when gtin_has_prefix(g, m.gs1_prefix) then 'ok' else 'pending' end;
  insert into mfr_products(manufacturer_id, name, strength, dosage_form, pack_size, gtin, nafdac_no, nafdac_expiry, review)
    values (m.id, trim(p_name), nullif(trim(p_strength),''), nullif(trim(p_form),''), nullif(trim(p_pack),''), g, upper(trim(p_nafdac)), p_nafdac_exp, rv)
    returning * into r;
  insert into audit_log(manufacturer_id, actor, action, detail)
    values (m.id, auth.uid(), case when rv = 'ok' then 'product_added' else 'product_waiting_review' end, r.name || ' (' || g || ')');
  return to_jsonb(r) - 'manufacturer_id';
end $$;

create or replace function admin_review_product(p_id uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r mfr_products;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update mfr_products set review = case when p_ok then 'ok' else 'rejected' end where id = p_id returning * into r;
  if r.id is null then raise exception 'Product not found'; end if;
  insert into audit_log(manufacturer_id, actor, action, detail)
    values (r.manufacturer_id, auth.uid(), case when p_ok then 'product_approved' else 'product_rejected' end, r.name || ' (' || r.gtin || ')');
end $$;

-- A pending or rejected product never shows Genuine.
create or replace function verify_pack(p_gtin text, p_serial text, p_lot text, p_exp date, p_device text, p_city text, p_state text, p_record boolean default true)
returns json language plpgsql security definer set search_path = public as $$
declare pr record; s mfr_serials; b mfr_batches; v text; base jsonb; lot_ok boolean; exp_ok boolean;
begin
  select p.id, p.name, p.strength, p.dosage_form, p.manufacturer_id, m.legal_name, m.trading_name into pr
    from mfr_products p join manufacturers m on m.id = p.manufacturer_id
    where p.gtin = p_gtin and m.status = 'approved' and p.review = 'ok' limit 1;
  if pr.id is null then return json_build_object('enrolled', false); end if;
  base := jsonb_build_object('enrolled', true, 'maker', pr.legal_name, 'product', pr.name, 'strength', pr.strength, 'form', pr.dosage_form);
  if coalesce(trim(p_serial),'') = '' then return (base || jsonb_build_object('verdict', 'no_serial'))::json; end if;
  select * into s from mfr_serials where gtin = p_gtin and serial = trim(p_serial);
  if s.gtin is not null then
    select * into b from mfr_batches where id = s.batch_id;
    lot_ok := coalesce(trim(p_lot),'') = '' or upper(trim(p_lot)) = upper(b.lot);
    exp_ok := p_exp is null or date_trunc('month', p_exp) = date_trunc('month', b.exp_date);
    if p_record then
      if s.first_device is null then
        update mfr_serials set first_device = left(p_device,64), first_scan_at = now(), first_scan_city = left(p_city,60), first_scan_state = left(p_state,40)
          where gtin = s.gtin and serial = s.serial;
      elsif s.first_device is distinct from p_device then
        update mfr_serials set other_scans = other_scans + 1 where gtin = s.gtin and serial = s.serial;
        s.other_scans := s.other_scans + 1;
      end if;
    end if;
    v := case when b.recalled then 'recalled'
              when not lot_ok or not exp_ok then 'mismatch'
              when s.first_device is not null and s.first_device is distinct from p_device and s.other_scans > 0 then 'genuine_seen'
              else 'genuine' end;
    return (base || jsonb_build_object('verdict', v, 'lot', b.lot, 'exp', b.exp_date, 'mfg', b.mfg_date, 'recall_note', b.recall_note,
      'other_scans', s.other_scans, 'first_city', s.first_scan_city, 'first_state', s.first_scan_state,
      'lot_ok', lot_ok, 'exp_ok', exp_ok))::json;
  end if;
  select * into b from mfr_batches where product_id = pr.id and upper(lot) = upper(coalesce(trim(p_lot),'')) limit 1;
  if b.id is not null then
    if exists (select 1 from mfr_serials where batch_id = b.id) then
      return (base || jsonb_build_object('verdict', 'unknown_serial', 'lot', b.lot, 'batch_known', true))::json;
    end if;
    return (base || jsonb_build_object('verdict', case when b.recalled then 'recalled' else 'batch_ok' end, 'lot', b.lot, 'exp', b.exp_date,
      'exp_ok', p_exp is null or date_trunc('month', p_exp) = date_trunc('month', b.exp_date), 'recall_note', b.recall_note))::json;
  end if;
  if exists (select 1 from mfr_serials where gtin = p_gtin) then
    return (base || jsonb_build_object('verdict', 'unknown_serial', 'batch_known', false))::json;
  end if;
  return (base || jsonb_build_object('verdict', 'not_uploaded'))::json;
end $$;

-- Demo batches carry product_id so the dashboard can group them by product.
create or replace function demo_portal() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('company', to_jsonb(m) - 'owner' - 'email_code_hash' - 'courier_code_hash',
    'checks', coalesce((select json_agg(json_build_object('kind', c.kind, 'status', c.status, 'note', c.note, 'checked_at', c.checked_at)) from mfr_checks c where c.manufacturer_id = m.id and c.kind in ('nafdac','pcn','cac','gs1','email','courier')), '[]'::json),
    'products', coalesce((select json_agg(to_jsonb(p) - 'manufacturer_id' order by p.name) from mfr_products p where p.manufacturer_id = m.id), '[]'::json),
    'batches', coalesce((select json_agg(json_build_object('id', b.id, 'product_id', b.product_id, 'product', p.name, 'strength', p.strength, 'gtin', p.gtin, 'lot', b.lot,
        'mfg_date', b.mfg_date, 'exp_date', b.exp_date, 'quantity', b.quantity, 'recalled', b.recalled,
        'serials', (select count(*) from mfr_serials s where s.batch_id = b.id),
        'scanned', (select count(*) from mfr_serials s where s.batch_id = b.id and s.first_scan_at is not null),
        'copies', (select count(*) from mfr_serials s where s.batch_id = b.id and s.other_scans > 0)) order by b.created_at)
      from mfr_batches b join mfr_products p on p.id = b.product_id where b.manufacturer_id = m.id), '[]'::json),
    'events', coalesce((select json_agg(json_build_object('action', a.action, 'detail', a.detail, 'at', a.at) order by a.at desc) from audit_log a where a.manufacturer_id = m.id), '[]'::json))
  from manufacturers m where m.is_demo order by m.created_at limit 1;
$$;

revoke execute on function add_product, admin_review_product from public, anon;
grant execute on function add_product, admin_review_product to authenticated;
grant execute on function verify_pack, demo_portal to anon, authenticated;

notify pgrst, 'reload schema';
select 'part 007 done: ' || (select count(*) from mfr_products where review = 'ok') as result;
