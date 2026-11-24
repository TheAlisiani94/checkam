-- CheckAm update 005: private storage for manufacturer documents and reviewer evidence.
-- Run once in Supabase > SQL Editor after 004.
-- Files live in the private bucket "mfr-docs" under <manufacturer id>/...
-- A company can upload and read only its own folder (and upload only while its application is a draft);
-- admins can read everything and upload evidence.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mfr-docs', 'mfr-docs', false, 10485760, array['application/pdf','image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "mfr docs read" on storage.objects;
create policy "mfr docs read" on storage.objects for select to authenticated
  using (bucket_id = 'mfr-docs' and ((storage.foldername(name))[1] = public.my_manufacturer_id()::text or public.is_admin()));

drop policy if exists "mfr docs upload" on storage.objects;
create policy "mfr docs upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'mfr-docs' and (
    public.is_admin()
    or ((storage.foldername(name))[1] = public.my_manufacturer_id()::text
        and exists (select 1 from public.manufacturers m where m.id = public.my_manufacturer_id() and m.status in ('draft','rejected')))));

drop policy if exists "mfr docs delete" on storage.objects;
create policy "mfr docs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'mfr-docs' and (storage.foldername(name))[1] = public.my_manufacturer_id()::text
         and exists (select 1 from public.manufacturers m where m.id = public.my_manufacturer_id() and m.status in ('draft','rejected')));
