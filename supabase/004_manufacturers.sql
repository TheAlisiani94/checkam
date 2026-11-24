-- CheckAm update 004: manufacturer verification.
-- Run once in Supabase > SQL Editor after 003. Safe to run again.
--
-- Flow: a manufacturer creates an account, fills in an application and uploads documents,
-- then submits. Eight checks are created. Reviewers confirm the public-record checks
-- (NAFDAC, PCN, CAC, GS1) and the identity checks (phone call-back, letter of authority);
-- the company proves its email and factory address by entering codes CheckAm sends.
-- When every check has passed the manufacturer is approved automatically, and notices are
-- queued for the agencies. An agency can object through a private link, which suspends
-- the manufacturer at once until the objection is withdrawn.

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists admins (
  user_id uuid primary key references auth.users on delete cascade,
  role text not null default 'reviewer' check (role in ('owner','reviewer')),
  name text,
  created_at timestamptz not null default now()
);

create table if not exists manufacturers (
  id uuid primary key default gen_random_uuid(),
  owner uuid references auth.users on delete set null,
  is_demo boolean not null default false,
  status text not null default 'draft' check (status in ('draft','pending','approved','suspended','rejected')),
  kind text not null default 'manufacturer' check (kind in ('manufacturer','importer')),
  legal_name text, trading_name text, rc_number text, gs1_prefix text,
  factory_address text, city text, state text, website text, official_email text, public_phone text,
  contact_name text, contact_role text, contact_phone text,
  foreign_manufacturer text, foreign_country text,
  status_reason text,
  email_code_hash text, courier_code_hash text,
  created_at timestamptz not null default now(), submitted_at timestamptz, approved_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists manufacturers_owner_idx on manufacturers(owner) where owner is not null;

create table if not exists mfr_products (
  id uuid primary key default gen_random_uuid(),
  manufacturer_id uuid not null references manufacturers on delete cascade,
  name text not null, strength text, dosage_form text, pack_size text,
  gtin text, nafdac_no text, nafdac_expiry date, country text,
  created_at timestamptz not null default now()
);
create index if not exists mfr_products_mid_idx on mfr_products(manufacturer_id);

create table if not exists mfr_documents (
  id uuid primary key default gen_random_uuid(),
  manufacturer_id uuid not null references manufacturers on delete cascade,
  kind text not null check (kind in ('cac','nafdac','pcn','gs1','letter','other')),
  path text not null, file_name text,
  uploaded_at timestamptz not null default now()
);

create table if not exists mfr_checks (
  id uuid primary key default gen_random_uuid(),
  manufacturer_id uuid not null references manufacturers on delete cascade,
  kind text not null check (kind in ('nafdac','pcn','cac','gs1','email','courier','phone','letter')),
  status text not null default 'pending' check (status in ('pending','passed','failed')),
  note text, evidence_path text, checked_by uuid, checked_at timestamptz,
  unique (manufacturer_id, kind)
);

create table if not exists agency_contacts (
  agency text primary key, email text, phone text, website text
);
insert into agency_contacts(agency, email, phone, website) values
  ('NAFDAC', null, '0800-162-3322', 'https://nafdac.gov.ng'),
  ('PCN', null, null, 'https://pcn.gov.ng')
on conflict (agency) do nothing;

create table if not exists agency_notices (
  id uuid primary key default gen_random_uuid(),
  manufacturer_id uuid not null references manufacturers on delete cascade,
  agency text not null,
  token uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  objection boolean not null default false,
  objection_note text, objected_at timestamptz, withdrawn_at timestamptz
);

create table if not exists outbox (
  id uuid primary key default gen_random_uuid(),
  manufacturer_id uuid references manufacturers on delete cascade,
  to_label text, to_email text, subject text, body text,
  created_at timestamptz not null default now(), sent_at timestamptz
);

create table if not exists audit_log (
  id bigserial primary key,
  manufacturer_id uuid references manufacturers on delete cascade,
  actor uuid, action text not null, detail text,
  at timestamptz not null default now()
);

-- ---------- helpers ----------
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

create or replace function my_manufacturer_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from manufacturers where owner = auth.uid() limit 1;
$$;

create or replace function log_event(p_mid uuid, p_action text, p_detail text)
returns void language sql security definer set search_path = public as $$
  insert into audit_log(manufacturer_id, actor, action, detail) values (p_mid, auth.uid(), p_action, left(p_detail, 1000));
$$;

-- ---------- access rules ----------
alter table admins enable row level security;
alter table manufacturers enable row level security;
alter table mfr_products enable row level security;
alter table mfr_documents enable row level security;
alter table mfr_checks enable row level security;
alter table agency_contacts enable row level security;
alter table agency_notices enable row level security;
alter table outbox enable row level security;
alter table audit_log enable row level security;

revoke all on admins, manufacturers, mfr_products, mfr_documents, mfr_checks, agency_contacts, agency_notices, outbox, audit_log from anon, authenticated;

-- Admins see everything (reads); all admin writes go through functions below.
grant select on admins, mfr_products, mfr_documents, mfr_checks, agency_contacts, agency_notices, outbox, audit_log to authenticated;
grant select (id, owner, is_demo, status, kind, legal_name, trading_name, rc_number, gs1_prefix, factory_address, city, state, website,
  official_email, public_phone, contact_name, contact_role, contact_phone, foreign_manufacturer, foreign_country, status_reason,
  created_at, submitted_at, approved_at, updated_at) on manufacturers to authenticated;
drop policy if exists adm_read on admins;            create policy adm_read on admins for select to authenticated using (is_admin());
drop policy if exists adm_read on agency_contacts;   create policy adm_read on agency_contacts for select to authenticated using (is_admin());
drop policy if exists adm_read on agency_notices;    create policy adm_read on agency_notices for select to authenticated using (is_admin());
drop policy if exists adm_read on outbox;            create policy adm_read on outbox for select to authenticated using (is_admin());
drop policy if exists adm_read on audit_log;         create policy adm_read on audit_log for select to authenticated using (is_admin() or manufacturer_id = my_manufacturer_id());

-- Manufacturers: read own; create own draft; edit own application only while draft or rejected,
-- and only the application fields (status, demo flag and codes can never be set by the company).
drop policy if exists m_read on manufacturers;
create policy m_read on manufacturers for select to authenticated using (owner = auth.uid() or is_admin());
drop policy if exists m_insert on manufacturers;
create policy m_insert on manufacturers for insert to authenticated with check (owner = auth.uid() and status = 'draft' and not is_demo);
drop policy if exists m_update on manufacturers;
create policy m_update on manufacturers for update to authenticated
  using (owner = auth.uid() and status in ('draft','rejected')) with check (owner = auth.uid());
grant insert (owner, kind, legal_name, trading_name, rc_number, gs1_prefix, factory_address, city, state, website,
  official_email, public_phone, contact_name, contact_role, contact_phone, foreign_manufacturer, foreign_country) on manufacturers to authenticated;
grant update (kind, legal_name, trading_name, rc_number, gs1_prefix, factory_address, city, state, website,
  official_email, public_phone, contact_name, contact_role, contact_phone, foreign_manufacturer, foreign_country, updated_at) on manufacturers to authenticated;

-- Products and documents: the company manages its own while draft or rejected; admins read all.
drop policy if exists p_read on mfr_products;
create policy p_read on mfr_products for select to authenticated using (manufacturer_id = my_manufacturer_id() or is_admin());
drop policy if exists p_write on mfr_products;
create policy p_write on mfr_products for all to authenticated
  using (manufacturer_id = my_manufacturer_id() and exists (select 1 from manufacturers m where m.id = manufacturer_id and m.status in ('draft','rejected')))
  with check (manufacturer_id = my_manufacturer_id() and exists (select 1 from manufacturers m where m.id = manufacturer_id and m.status in ('draft','rejected')));
grant insert, update, delete on mfr_products to authenticated;

drop policy if exists d_read on mfr_documents;
create policy d_read on mfr_documents for select to authenticated using (manufacturer_id = my_manufacturer_id() or is_admin());
drop policy if exists d_write on mfr_documents;
create policy d_write on mfr_documents for all to authenticated
  using (manufacturer_id = my_manufacturer_id() and exists (select 1 from manufacturers m where m.id = manufacturer_id and m.status in ('draft','rejected')))
  with check (manufacturer_id = my_manufacturer_id() and exists (select 1 from manufacturers m where m.id = manufacturer_id and m.status in ('draft','rejected')));
grant insert, delete on mfr_documents to authenticated;

-- Checks: the company can see its own progress; only functions change them.
drop policy if exists c_read on mfr_checks;
create policy c_read on mfr_checks for select to authenticated using (manufacturer_id = my_manufacturer_id() or is_admin());

-- ---------- approval engine ----------
create or replace function maybe_approve(p_mid uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare m manufacturers; a record;
begin
  select * into m from manufacturers where id = p_mid for update;
  if m.status <> 'pending' then return false; end if;
  if (select count(*) from mfr_checks where manufacturer_id = p_mid and status = 'passed') < 8 then return false; end if;
  update manufacturers set status = 'approved', approved_at = now(), status_reason = null, updated_at = now() where id = p_mid;
  perform log_event(p_mid, 'approved', 'All 8 checks passed; approved automatically');
  -- notices to agencies, each with a private objection link
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
    E' has passed all CheckAm verification checks and is now approved.\n\nWe have informed NAFDAC and PCN, as is our practice. If either agency raises an objection, your approval will be paused and we will tell you.\n\nCheckAm');
  return true;
end $$;

-- ---------- company functions ----------
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
  if coalesce(trim(m.public_phone),'') = '' then missing := missing || 'public company phone'::text; end if;
  if coalesce(trim(m.contact_name),'') = '' then missing := missing || 'contact person'::text; end if;
  if coalesce(trim(m.gs1_prefix),'') = '' then missing := missing || 'GS1 company prefix'::text; end if;
  if not exists (select 1 from mfr_products where manufacturer_id = m.id and coalesce(nafdac_no,'') <> '') then missing := missing || 'at least one product with a NAFDAC number'::text; end if;
  if not exists (select 1 from mfr_documents where manufacturer_id = m.id and kind = 'cac') then missing := missing || 'CAC certificate'::text; end if;
  if not exists (select 1 from mfr_documents where manufacturer_id = m.id and kind = 'nafdac') then missing := missing || 'NAFDAC certificate(s)'::text; end if;
  if not exists (select 1 from mfr_documents where manufacturer_id = m.id and kind = 'pcn') then missing := missing || 'PCN premises licence'::text; end if;
  if not exists (select 1 from mfr_documents where manufacturer_id = m.id and kind = 'gs1') then missing := missing || 'GS1 membership certificate'::text; end if;
  if not exists (select 1 from mfr_documents where manufacturer_id = m.id and kind = 'letter') then missing := missing || 'letter of authority'::text; end if;
  if array_length(missing,1) > 0 then raise exception 'Missing: %', array_to_string(missing, ', '); end if;
  update manufacturers set status = 'pending', submitted_at = now(), status_reason = null, updated_at = now() where id = m.id;
  insert into mfr_checks(manufacturer_id, kind)
    select m.id, k from unnest(array['nafdac','pcn','cac','gs1','email','courier','phone','letter']) k
  on conflict (manufacturer_id, kind) do update set status = case when mfr_checks.status = 'failed' then 'pending' else mfr_checks.status end;
  perform log_event(m.id, 'submitted', 'Application submitted for verification');
  return 'pending';
end $$;

create or replace function enter_code(p_kind text, p_code text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare m manufacturers; h text; tries int;
begin
  if p_kind not in ('email','courier') then raise exception 'Unknown code'; end if;
  select * into m from manufacturers where owner = auth.uid();
  if m.id is null or m.status <> 'pending' then raise exception 'No pending application'; end if;
  select count(*) into tries from audit_log where manufacturer_id = m.id and action = 'code_wrong' and at > now() - interval '1 day';
  if tries >= 5 then raise exception 'Too many wrong codes today. Try again tomorrow.'; end if;
  h := case p_kind when 'email' then m.email_code_hash else m.courier_code_hash end;
  if h is null then raise exception 'This code has not been sent yet'; end if;
  if crypt(upper(trim(p_code)), h) <> h then
    perform log_event(m.id, 'code_wrong', p_kind); return false;
  end if;
  update mfr_checks set status = 'passed', note = 'Code entered by the company', checked_at = now(), checked_by = auth.uid()
    where manufacturer_id = m.id and kind = p_kind;
  perform log_event(m.id, 'code_ok', p_kind);
  perform maybe_approve(m.id);
  return true;
end $$;

-- ---------- admin functions ----------
create or replace function claim_owner(p_name text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from admins) then return false; end if;
  insert into admins(user_id, role, name) values (auth.uid(), 'owner', left(p_name,60));
  return true;
end $$;

create or replace function admin_add(p_email text, p_role text, p_name text) returns boolean
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  if not exists (select 1 from admins where user_id = auth.uid() and role = 'owner') then raise exception 'Only the owner can add admins'; end if;
  select id into u from auth.users where lower(email) = lower(trim(p_email));
  if u is null then raise exception 'No CheckAm account with that email. Ask them to create one first.'; end if;
  insert into admins(user_id, role, name) values (u, case when p_role = 'owner' then 'owner' else 'reviewer' end, left(p_name,60))
    on conflict (user_id) do update set role = excluded.role, name = excluded.name;
  return true;
end $$;

create or replace function admin_set_check(p_mid uuid, p_kind text, p_status text, p_note text, p_evidence text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_status not in ('pending','passed','failed') then raise exception 'Bad status'; end if;
  if p_status = 'passed' and coalesce(trim(p_note),'') = '' and coalesce(p_evidence,'') = '' then
    raise exception 'Add a note or evidence explaining how this was confirmed';
  end if;
  update mfr_checks set status = p_status, note = left(p_note, 500), evidence_path = coalesce(p_evidence, evidence_path),
    checked_by = auth.uid(), checked_at = now()
  where manufacturer_id = p_mid and kind = p_kind;
  if not found then raise exception 'Check not found'; end if;
  perform log_event(p_mid, 'check_' || p_status, p_kind || coalesce(': ' || p_note, ''));
  if p_status = 'failed' then
    insert into outbox(manufacturer_id, to_label, to_email, subject, body)
    select p_mid, 'Company', official_email, 'CheckAm: please update your application',
      'Hello ' || coalesce(contact_name,'') || E',\n\nOne verification check needs your attention: ' || p_kind || E'.\nReason: ' || coalesce(p_note,'-') ||
      E'\n\nPlease sign in to the CheckAm partner portal to see the details.\n\nCheckAm'
    from manufacturers where id = p_mid;
  end if;
  return maybe_approve(p_mid);
end $$;

-- Creates a one-time code and returns it once. The email code is queued in the outbox;
-- the courier code must be printed and sent to the factory address.
create or replace function admin_issue_code(p_mid uuid, p_kind text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare c text; m manufacturers;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_kind not in ('email','courier') then raise exception 'Unknown code'; end if;
  select * into m from manufacturers where id = p_mid;
  c := upper(substr(translate(encode(gen_random_bytes(9), 'base64'), '+/=0O1IL', ''), 1, 8));
  if p_kind = 'email' then
    update manufacturers set email_code_hash = crypt(c, gen_salt('bf')) where id = p_mid;
    insert into outbox(manufacturer_id, to_label, to_email, subject, body) values (p_mid, 'Company', m.official_email,
      'Your CheckAm email verification code',
      'Hello ' || coalesce(m.contact_name,'') || E',\n\nYour CheckAm email verification code is: ' || c ||
      E'\n\nSign in to the CheckAm partner portal and enter it to confirm this is your official company email.\n\nCheckAm');
  else
    update manufacturers set courier_code_hash = crypt(c, gen_salt('bf')) where id = p_mid;
  end if;
  perform log_event(p_mid, 'code_issued', p_kind);
  return c;
end $$;

create or replace function admin_set_status(p_mid uuid, p_status text, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
declare m manufacturers;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_status not in ('suspended','rejected','approved','pending') then raise exception 'Bad status'; end if;
  if p_status = 'approved' and (select count(*) from mfr_checks where manufacturer_id = p_mid and status = 'passed') < 8 then
    raise exception 'All 8 checks must pass first';
  end if;
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

create or replace function admin_set_agency(p_agency text, p_email text, p_phone text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update agency_contacts set email = nullif(trim(p_email),''), phone = nullif(trim(p_phone),'') where agency = p_agency;
  update outbox set to_email = nullif(trim(p_email),'') where to_label = p_agency and sent_at is null and to_email is null;
  return true;
end $$;

create or replace function admin_mark_sent(p_id uuid) returns boolean
language sql security definer set search_path = public as $$
  update outbox set sent_at = now() where id = p_id and is_admin() returning true;
$$;

-- ---------- agency link (no account) ----------
create or replace function agency_view(p_token uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('agency', n.agency, 'objection', n.objection and n.withdrawn_at is null, 'objection_note', n.objection_note,
    'company', json_build_object('legal_name', m.legal_name, 'rc_number', m.rc_number, 'kind', m.kind, 'factory_address', m.factory_address,
      'city', m.city, 'state', m.state, 'website', m.website, 'official_email', m.official_email, 'public_phone', m.public_phone,
      'status', m.status, 'approved_at', m.approved_at),
    'products', coalesce((select json_agg(json_build_object('name', p.name, 'strength', p.strength, 'nafdac_no', p.nafdac_no, 'gtin', p.gtin) order by p.name)
      from mfr_products p where p.manufacturer_id = m.id), '[]'::json))
  from agency_notices n join manufacturers m on m.id = n.manufacturer_id
  where n.token = p_token;
$$;

create or replace function agency_object(p_token uuid, p_note text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n agency_notices; m manufacturers; c agency_contacts;
begin
  select * into n from agency_notices where token = p_token for update;
  if n.id is null then raise exception 'Link not valid'; end if;
  if coalesce(trim(p_note),'') = '' then raise exception 'Please give a short reason'; end if;
  update agency_notices set objection = true, objection_note = left(p_note, 1000), objected_at = now(), withdrawn_at = null where id = n.id;
  update manufacturers set status = 'suspended', status_reason = 'Objection from ' || n.agency || ': ' || left(p_note, 300), updated_at = now()
    where id = n.manufacturer_id returning * into m;
  select * into c from agency_contacts where agency = n.agency;
  insert into audit_log(manufacturer_id, action, detail) values (n.manufacturer_id, 'agency_objection', n.agency || ': ' || left(p_note, 500));
  insert into outbox(manufacturer_id, to_label, to_email, subject, body) values (n.manufacturer_id, 'Company', m.official_email,
    'CheckAm: your approval is paused after an objection from ' || n.agency,
    'Hello ' || coalesce(m.contact_name,'') || E',\n\n' || n.agency || ' has raised an objection to your CheckAm approval:' ||
    E'\n"' || left(p_note, 500) || E'"\n\nYour products will not show as "Genuine" until this is resolved. Please contact ' || n.agency ||
    coalesce(' (' || c.phone || ')', '') || coalesce(', ' || c.email, '') || coalesce(', ' || c.website, '') ||
    E' to clear it. When ' || n.agency || E' withdraws the objection, your approval returns automatically.\n\nCheckAm');
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
     and (select count(*) from mfr_checks where manufacturer_id = m.id and status = 'passed') = 8 then
    update manufacturers set status = 'approved', status_reason = null, updated_at = now() where id = m.id;
    insert into outbox(manufacturer_id, to_label, to_email, subject, body) values (m.id, 'Company', m.official_email,
      'CheckAm: your approval is active again',
      'Hello ' || coalesce(m.contact_name,'') || E',\n\n' || n.agency || E' has withdrawn its objection. Your CheckAm approval is active again.\n\nCheckAm');
  end if;
  return true;
end $$;

-- ---------- public demo ----------
create or replace function demo_portal() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('company', to_jsonb(m) - 'owner' - 'email_code_hash' - 'courier_code_hash',
    'checks', coalesce((select json_agg(json_build_object('kind', c.kind, 'status', c.status, 'note', c.note, 'checked_at', c.checked_at)) from mfr_checks c where c.manufacturer_id = m.id), '[]'::json),
    'products', coalesce((select json_agg(to_jsonb(p) - 'manufacturer_id' order by p.name) from mfr_products p where p.manufacturer_id = m.id), '[]'::json),
    'events', coalesce((select json_agg(json_build_object('action', a.action, 'detail', a.detail, 'at', a.at) order by a.at desc) from audit_log a where a.manufacturer_id = m.id), '[]'::json))
  from manufacturers m where m.is_demo order by m.created_at limit 1;
$$;

revoke execute on function maybe_approve(uuid), log_event(uuid, text, text) from public, anon, authenticated;
grant execute on function is_admin, my_manufacturer_id, submit_application, enter_code, claim_owner, admin_add, admin_set_check,
  admin_issue_code, admin_set_status, admin_set_agency, admin_mark_sent to authenticated;
grant execute on function agency_view, agency_object, agency_withdraw, demo_portal to anon, authenticated;

-- ---------- demo company (clearly fake) ----------
do $$
declare d uuid;
begin
  if not exists (select 1 from manufacturers where is_demo) then
    insert into manufacturers(is_demo, status, kind, legal_name, trading_name, rc_number, gs1_prefix, factory_address, city, state,
      website, official_email, public_phone, contact_name, contact_role, contact_phone, submitted_at, approved_at)
    values (true, 'approved', 'manufacturer', 'Demo Pharma Ltd (example only)', 'Demo Pharma', 'RC 0000000', '6159999',
      'Plot 1, Example Industrial Estate', 'Ikeja', 'Lagos', 'https://example.com', 'quality@example.com', '0800 000 0000',
      'Ada Example', 'Head of Quality', '0800 000 0001', now() - interval '6 days', now() - interval '1 day')
    returning id into d;
    insert into mfr_products(manufacturer_id, name, strength, dosage_form, pack_size, gtin, nafdac_no, nafdac_expiry, country) values
      (d, 'Demoquine (example)', '80/480 mg', 'Tablet', '6 tablets', '06159999000014', 'A4-0000', now()::date + 900, 'Nigeria'),
      (d, 'Democillin (example)', '500 mg', 'Capsule', '10 x 10 capsules', '06159999000021', 'A4-0001', now()::date + 600, 'Nigeria');
    insert into mfr_checks(manufacturer_id, kind, status, note, checked_at)
      select d, k, 'passed', n, now() - interval '2 days' from (values
        ('nafdac','Both products found in the NAFDAC Greenbook under Demo Pharma Ltd, status active'),
        ('pcn','PCN Verify Premises: registered and current'),
        ('cac','CAC public search: active, address matches'),
        ('gs1','Verified by GS1: prefix 6159999 licensed to Demo Pharma Ltd'),
        ('email','Code entered by the company'),
        ('courier','Code entered by the company'),
        ('phone','Called the public number; Head of Quality confirmed the application'),
        ('letter','Letter of authority on company letterhead, signed by the MD')) v(k, n);
    insert into audit_log(manufacturer_id, action, detail, at) values
      (d, 'submitted', 'Application submitted for verification', now() - interval '6 days'),
      (d, 'approved', 'All 8 checks passed; approved automatically', now() - interval '1 day');
  end if;
end $$;
