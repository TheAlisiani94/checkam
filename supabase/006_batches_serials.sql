-- CheckAm update 006: batches, serial numbers and "Genuine" results; 6 verification checks;
-- automatic email code on submission. Run once after 005. Safe to run again.

-- ---------- six required checks (letter of authority and phone call-back removed) ----------
create or replace function required_checks_passed(p_mid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from mfr_checks where manufacturer_id = p_mid and status = 'passed'
          and kind in ('nafdac','pcn','cac','gs1','email','courier')) = 6;
$$;

create or replace function maybe_approve(p_mid uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare m manufacturers; a record;
begin
  select * into m from manufacturers where id = p_mid for update;
  if m.status <> 'pending' then return false; end if;
  if not required_checks_passed(p_mid) then return false; end if;
  update manufacturers set status = 'approved', approved_at = now(), status_reason = null, updated_at = now() where id = p_mid;
  perform log_event(p_mid, 'approved', 'All 6 checks passed; approved automatically');
  for a in select * from agency_contacts where agency in ('NAFDAC','PCN') loop
    with n as (insert into agency_notices(manufacturer_id, agency) values (p_mid, a.agency) returning token)
    insert into outbox(manufacturer_id, to_label, to_email, subject, body)
    select p_mid, a.agency, a.email,
      'CheckAm: ' || coalesce(m.legal_name,'a company') || ' approved based on your public records',
      'Dear ' || a.agency || E',\n\n' ||
      coalesce(m.legal_name,'') || ' (CAC RC ' || coalesce(m.rc_number,'-') || '), ' || coalesce(m.factory_address,'') || ', ' || coalesce(m.state,'') ||
      E', has been approved on CheckAm, a free public app that helps Nigerians check medicine packs. The approval relied on your public records, including the products and registration numbers listed below.\n\n' ||
      coalesce((select string_agg('- ' || p.name || coalesce(' ' || p.strength,'') || ', NAFDAC no. ' || coalesce(p.nafdac_no,'-'), E'\n') from mfr_products p where p.manufacturer_id = p_mid), '- (no products listed)') ||
      E'\n\nIf this company should not be approved, please open this private link and press Object. The company will be suspended immediately:\n' ||
      '{{SITE}}/agency.html?t=' || n.token::text ||
      E'\n\nNo account is needed. Thank you.\nCheckAm'
    from n;
  end loop;
  insert into outbox(manufacturer_id, to_label, to_email, subject, body) values (p_mid, 'Company', m.official_email,
    'Your company is verified on CheckAm',
    'Hello ' || coalesce(m.contact_name,'') || E',\n\n' || coalesce(m.legal_name,'Your company') ||
    E' has passed all CheckAm verification checks and is now approved. Sign in to the partner portal to add your batches and serial numbers, so buyers see "Genuine" when they scan your packs.\n\nWe have informed NAFDAC and PCN, as is our practice. If either agency raises an objection, your approval will be paused and we will tell you.\n\nCheckAm');
  return true;
end $$;

-- Issues the email code automatically on submission and queues it.
create or replace function issue_email_code(p_mid uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c text; m manufacturers;
begin
  select * into m from manufacturers where id = p_mid;
  c := upper(substr(translate(encode(gen_random_bytes(9), 'base64'), '+/=0O1IL', ''), 1, 8));
  update manufacturers set email_code_hash = crypt(c, gen_salt('bf')) where id = p_mid;
  insert into outbox(manufacturer_id, to_label, to_email, subject, body) values (p_mid, 'Company', m.official_email,
    'Your CheckAm email verification code',
    'Hello ' || coalesce(m.contact_name,'') || E',\n\nYour CheckAm email verification code is: ' || c ||
    E'\n\nSign in to the CheckAm partner portal and enter it to confirm this is your official company email.\n\nCheckAm');
  perform log_event(p_mid, 'code_issued', 'email (automatic)');
end $$;

create or replace function submit_application() returns text
language plpgsql security definer set search_path = public as $$
declare m manufacturers; missing text[] := '{}';
begin
  select * into m from manufacturers where owner = auth.uid();
  if m.id is null then raise exception 'No application found'; end if;
  if m.status not in ('draft','rejected') then raise exception 'Application already submitted'; end if;
  if coalesce(trim(m.legal_name),'') = '' then missing := missing || 'company legal name'::text; end if;
  if coalesce(trim(m.rc_number),'') = '' then missing := missing || 'CAC RC number'::text; end if;
  if coalesce(trim(m.factory_address),'') = '' then missing := missing || 'factory address'::text; end if;
  if coalesce(trim(m.state),'') = '' then missing := missing || 'state'::text; end if;
  if coalesce(trim(m.official_email),'') = '' then missing := missing || 'official company email'::text; end if;
  if coalesce(trim(m.public_phone),'') = '' then missing := missing || 'company phone'::text; end if;
  if coalesce(trim(m.contact_name),'') = '' then missing := missing || 'contact person'::text; end if;
  if coalesce(trim(m.gs1_prefix),'') = '' then missing := missing || 'GS1 company prefix'::text; end if;
  if not exists (select 1 from mfr_products where manufacturer_id = m.id and coalesce(nafdac_no,'') <> '') then missing := missing || 'at least one product with a NAFDAC number'::text; end if;
  if not exists (select 1 from mfr_documents where manufacturer_id = m.id and kind = 'cac') then missing := missing || 'CAC certificate'::text; end if;
  if not exists (select 1 from mfr_documents where manufacturer_id = m.id and kind = 'nafdac') then missing := missing || 'NAFDAC certificate(s)'::text; end if;
  if not exists (select 1 from mfr_documents where manufacturer_id = m.id and kind = 'pcn') then missing := missing || 'PCN premises licence'::text; end if;
  if not exists (select 1 from mfr_documents where manufacturer_id = m.id and kind = 'gs1') then missing := missing || 'GS1 membership certificate'::text; end if;
  if array_length(missing,1) > 0 then raise exception 'Missing: %', array_to_string(missing, ', '); end if;
  update manufacturers set status = 'pending', submitted_at = now(), status_reason = null, updated_at = now() where id = m.id;
  insert into mfr_checks(manufacturer_id, kind)
    select m.id, k from unnest(array['nafdac','pcn','cac','gs1','email','courier']) k
  on conflict (manufacturer_id, kind) do update set status = case when mfr_checks.status = 'failed' then 'pending' else mfr_checks.status end;
  perform log_event(m.id, 'submitted', 'Application submitted for verification');
  if not exists (select 1 from mfr_checks where manufacturer_id = m.id and kind = 'email' and status = 'passed') then
    perform issue_email_code(m.id);
  end if;
  return 'pending';
end $$;

create or replace function admin_set_status(p_mid uuid, p_status text, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
declare m manufacturers;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_status not in ('suspended','rejected','approved','pending') then raise exception 'Bad status'; end if;
  if p_status = 'approved' and not required_checks_passed(p_mid) then raise exception 'All 6 checks must pass first'; end if;
  if p_status = 'approved' and exists (select 1 from agency_notices where manufacturer_id = p_mid and objection and withdrawn_at is null) then
    raise exception 'An agency objection is still open';
  end if;
  if p_status in ('suspended','rejected') and coalesce(trim(p_reason),'') = '' then raise exception 'Give a reason'; end if;
  update manufacturers set status = p_status, status_reason = nullif(trim(p_reason),''), updated_at = now(),
    approved_at = case when p_status = 'approved' then coalesce(approved_at, now()) else approved_at end
  where id = p_mid returning * into m;
  perform log_event(p_mid, 'status_' || p_status, p_reason);
  insert into outbox(manufacturer_id, to_label, to_email, subject, body) values (p_mid, 'Company', m.official_email,
    'CheckAm: your status is now ' || p_status,
    'Hello ' || coalesce(m.contact_name,'') || E',\n\nYour CheckAm status has changed to: ' || p_status || '.' ||
    coalesce(E'\nReason: ' || nullif(trim(p_reason),''), '') || E'\n\nSign in to the CheckAm partner portal for details.\n\nCheckAm');
  return true;
end $$;

create or replace function agency_withdraw(p_token uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare n agency_notices; m manufacturers;
begin
  select * into n from agency_notices where token = p_token for update;
  if n.id is null then raise exception 'Link not valid'; end if;
  update agency_notices set withdrawn_at = now() where id = n.id and objection;
  insert into audit_log(manufacturer_id, action, detail) values (n.manufacturer_id, 'agency_withdrawn', n.agency);
  select * into m from manufacturers where id = n.manufacturer_id;
  if m.status = 'suspended'
     and not exists (select 1 from agency_notices where manufacturer_id = m.id and objection and withdrawn_at is null)
     and required_checks_passed(m.id) then
    update manufacturers set status = 'approved', status_reason = null, updated_at = now() where id = m.id;
    insert into outbox(manufacturer_id, to_label, to_email, subject, body) values (m.id, 'Company', m.official_email,
      'CheckAm: your approval is active again',
      'Hello ' || coalesce(m.contact_name,'') || E',\n\n' || n.agency || E' has withdrawn its objection. Your CheckAm approval is active again.\n\nCheckAm');
  end if;
  return true;
end $$;

-- ---------- batches and serial numbers ----------
create table if not exists mfr_batches (
  id uuid primary key default gen_random_uuid(),
  manufacturer_id uuid not null references manufacturers on delete cascade,
  product_id uuid not null references mfr_products on delete cascade,
  lot text not null, mfg_date date, exp_date date not null, quantity int,
  recalled boolean not null default false, recall_note text,
  created_at timestamptz not null default now(),
  unique (product_id, lot)
);
create index if not exists mfr_batches_mid_idx on mfr_batches(manufacturer_id);

create table if not exists mfr_serials (
  gtin text not null, serial text not null,
  batch_id uuid not null references mfr_batches on delete cascade,
  manufacturer_id uuid not null references manufacturers on delete cascade,
  first_device text, first_scan_at timestamptz, first_scan_city text, first_scan_state text,
  other_scans int not null default 0,
  primary key (gtin, serial)
);
create index if not exists mfr_serials_batch_idx on mfr_serials(batch_id);
create index if not exists mfr_products_gtin_idx on mfr_products(gtin);

alter table mfr_batches enable row level security;
alter table mfr_serials enable row level security;
revoke all on mfr_batches, mfr_serials from anon, authenticated;
grant select, insert, delete on mfr_batches to authenticated;
grant update (recalled, recall_note, quantity, mfg_date, exp_date) on mfr_batches to authenticated;
grant select on mfr_serials to authenticated;

create or replace function i_am_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from manufacturers where owner = auth.uid() and status = 'approved');
$$;

drop policy if exists b_read on mfr_batches;
create policy b_read on mfr_batches for select to authenticated using (manufacturer_id = my_manufacturer_id() or is_admin());
drop policy if exists b_insert on mfr_batches;
create policy b_insert on mfr_batches for insert to authenticated with check (
  manufacturer_id = my_manufacturer_id() and i_am_approved()
  and exists (select 1 from mfr_products p where p.id = product_id and p.manufacturer_id = my_manufacturer_id()));
drop policy if exists b_update on mfr_batches;
create policy b_update on mfr_batches for update to authenticated using (manufacturer_id = my_manufacturer_id() and i_am_approved())
  with check (manufacturer_id = my_manufacturer_id());
drop policy if exists b_delete on mfr_batches;
create policy b_delete on mfr_batches for delete to authenticated using (manufacturer_id = my_manufacturer_id() and i_am_approved());
drop policy if exists s_read on mfr_serials;
create policy s_read on mfr_serials for select to authenticated using (manufacturer_id = my_manufacturer_id() or is_admin());

-- Upload up to 5000 serial numbers at a time to one of your batches. Returns how many were new.
create or replace function add_serials(p_batch uuid, p_serials text[]) returns int
language plpgsql security definer set search_path = public as $$
declare b mfr_batches; g text; n int;
begin
  select * into b from mfr_batches where id = p_batch;
  if b.id is null or b.manufacturer_id <> my_manufacturer_id() then raise exception 'Batch not found'; end if;
  if not i_am_approved() then raise exception 'Only verified manufacturers can upload serial numbers'; end if;
  if coalesce(array_length(p_serials, 1), 0) > 5000 then raise exception 'Send at most 5000 serial numbers at a time'; end if;
  select gtin into g from mfr_products where id = b.product_id;
  if coalesce(g,'') = '' then raise exception 'This product has no product number (GTIN). Contact CheckAm to add it.'; end if;
  with ins as (
    insert into mfr_serials(gtin, serial, batch_id, manufacturer_id)
    select g, s, b.id, b.manufacturer_id from (select distinct trim(x) s from unnest(p_serials) x) t
    where s ~ '^[!-~]{1,20}$'
    on conflict (gtin, serial) do nothing returning 1)
  select count(*) into n from ins;
  insert into audit_log(manufacturer_id, actor, action, detail) values (b.manufacturer_id, auth.uid(), 'serials_added', b.lot || ': ' || n);
  return n;
end $$;

-- Your batches with serial and scan counts.
create or replace function my_batches() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', b.id, 'product_id', b.product_id, 'product', p.name, 'strength', p.strength, 'gtin', p.gtin,
      'lot', b.lot, 'mfg_date', b.mfg_date, 'exp_date', b.exp_date, 'quantity', b.quantity, 'recalled', b.recalled, 'created_at', b.created_at,
      'serials', (select count(*) from mfr_serials s where s.batch_id = b.id),
      'scanned', (select count(*) from mfr_serials s where s.batch_id = b.id and s.first_scan_at is not null),
      'copies', (select count(*) from mfr_serials s where s.batch_id = b.id and s.other_scans > 0)) order by b.created_at desc), '[]'::json)
  from mfr_batches b join mfr_products p on p.id = b.product_id
  where b.manufacturer_id = my_manufacturer_id();
$$;

-- The public check the scanner calls. Records the first scan of each genuine serial (p_record = true).
create or replace function verify_pack(p_gtin text, p_serial text, p_lot text, p_exp date, p_device text, p_city text, p_state text, p_record boolean default true)
returns json language plpgsql security definer set search_path = public as $$
declare pr record; s mfr_serials; b mfr_batches; v text; base jsonb; lot_ok boolean; exp_ok boolean;
begin
  select p.id, p.name, p.strength, p.dosage_form, p.manufacturer_id, m.legal_name, m.trading_name into pr
    from mfr_products p join manufacturers m on m.id = p.manufacturer_id
    where p.gtin = p_gtin and m.status = 'approved' limit 1;
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
    return (base || jsonb_build_object('verdict', v, 'lot', b.lot, 'exp', b.exp_date, 'recall_note', b.recall_note,
      'other_scans', s.other_scans, 'first_city', s.first_scan_city, 'first_state', s.first_scan_state,
      'lot_ok', lot_ok, 'exp_ok', exp_ok))::json;
  end if;
  -- serial not on the maker's list
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

-- Demo dashboard now includes batches.
create or replace function demo_portal() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('company', to_jsonb(m) - 'owner' - 'email_code_hash' - 'courier_code_hash',
    'checks', coalesce((select json_agg(json_build_object('kind', c.kind, 'status', c.status, 'note', c.note, 'checked_at', c.checked_at)) from mfr_checks c where c.manufacturer_id = m.id and c.kind in ('nafdac','pcn','cac','gs1','email','courier')), '[]'::json),
    'products', coalesce((select json_agg(to_jsonb(p) - 'manufacturer_id' order by p.name) from mfr_products p where p.manufacturer_id = m.id), '[]'::json),
    'batches', coalesce((select json_agg(json_build_object('id', b.id, 'product', p.name, 'strength', p.strength, 'gtin', p.gtin, 'lot', b.lot,
        'mfg_date', b.mfg_date, 'exp_date', b.exp_date, 'quantity', b.quantity, 'recalled', b.recalled,
        'serials', (select count(*) from mfr_serials s where s.batch_id = b.id),
        'scanned', (select count(*) from mfr_serials s where s.batch_id = b.id and s.first_scan_at is not null),
        'copies', (select count(*) from mfr_serials s where s.batch_id = b.id and s.other_scans > 0)) order by b.created_at)
      from mfr_batches b join mfr_products p on p.id = b.product_id where b.manufacturer_id = m.id), '[]'::json),
    'events', coalesce((select json_agg(json_build_object('action', a.action, 'detail', a.detail, 'at', a.at) order by a.at desc) from audit_log a where a.manufacturer_id = m.id), '[]'::json))
  from manufacturers m where m.is_demo order by m.created_at limit 1;
$$;

revoke execute on function issue_email_code(uuid) from public, anon, authenticated;
grant execute on function required_checks_passed, i_am_approved, add_serials, my_batches to authenticated;
grant execute on function verify_pack, demo_portal to anon, authenticated;

-- ---------- demo company: 6 checks, batches and serials ----------
do $$
declare d uuid; p1 uuid; p2 uuid; b1 uuid; b2 uuid;
begin
  select id into d from manufacturers where is_demo order by created_at limit 1;
  if d is null then return; end if;
  delete from mfr_checks where manufacturer_id = d and kind in ('phone','letter');
  -- correct the demo product numbers (valid GS1 check digits)
  update mfr_products set gtin = '06159999000011' where manufacturer_id = d and gtin = '06159999000014';
  update mfr_products set gtin = '06159999000028' where manufacturer_id = d and gtin = '06159999000021';
  update audit_log set detail = 'All 6 checks passed; approved automatically' where manufacturer_id = d and action = 'approved';
  if not exists (select 1 from mfr_batches where manufacturer_id = d) then
    select id into p1 from mfr_products where manufacturer_id = d and gtin = '06159999000011';
    select id into p2 from mfr_products where manufacturer_id = d and gtin = '06159999000028';
    insert into mfr_batches(manufacturer_id, product_id, lot, mfg_date, exp_date, quantity)
      values (d, p1, 'DQ2601', current_date - 40, (date_trunc('month', current_date) + interval '26 months')::date, 100) returning id into b1;
    insert into mfr_batches(manufacturer_id, product_id, lot, mfg_date, exp_date, quantity)
      values (d, p2, 'DC2602', current_date - 20, (date_trunc('month', current_date) + interval '20 months')::date, 50) returning id into b2;
    insert into mfr_serials(gtin, serial, batch_id, manufacturer_id)
      select '06159999000011', 'DEMO' || lpad(i::text, 4, '0'), b1, d from generate_series(1, 100) i;
    insert into mfr_serials(gtin, serial, batch_id, manufacturer_id)
      select '06159999000028', 'DCX' || lpad(i::text, 4, '0'), b2, d from generate_series(1, 50) i;
    insert into audit_log(manufacturer_id, action, detail, at) values
      (d, 'serials_added', 'DQ2601: 100', now() - interval '20 hours'),
      (d, 'serials_added', 'DC2602: 50', now() - interval '19 hours');
  end if;
end $$;

notify pgrst, 'reload schema';
