-- QuickDrop: accountless transfer spaces. All application mutations happen in Edge Functions.
create extension if not exists pgcrypto;
create schema if not exists private;

create type public.transfer_space_status as enum ('active', 'expired', 'destroyed');
create type public.quickdrop_device_type as enum ('web', 'ios', 'android');
create type public.transfer_item_type as enum ('file', 'text');
create type public.rate_limit_action as enum ('create_space', 'pair_code_attempt', 'upload');

create table public.transfer_spaces (
  id uuid primary key default gen_random_uuid(),
  owner_anonymous_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '临时传输空间' check (char_length(name) between 1 and 80),
  status public.transfer_space_status not null default 'active',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  destroyed_at timestamptz,
  check (expires_at > created_at)
);

create table public.pairing_codes (
  id uuid primary key default gen_random_uuid(),
  transfer_space_id uuid not null references public.transfer_spaces(id) on delete cascade,
  code_hash text not null,
  pairing_token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
create unique index pairing_codes_live_code_hash_unique on public.pairing_codes (code_hash)
  where used_at is null;

create table public.paired_devices (
  id uuid primary key default gen_random_uuid(),
  transfer_space_id uuid not null references public.transfer_spaces(id) on delete cascade,
  anonymous_user_id uuid not null references auth.users(id) on delete cascade,
  device_name text not null check (char_length(device_name) between 1 and 80),
  device_type public.quickdrop_device_type not null,
  device_token_hash text not null unique,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (transfer_space_id, anonymous_user_id)
);

create table public.transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_space_id uuid not null references public.transfer_spaces(id) on delete cascade,
  uploader_device_id uuid references public.paired_devices(id) on delete set null,
  uploader_anonymous_user_id uuid not null references auth.users(id) on delete cascade,
  type public.transfer_item_type not null,
  title text not null check (char_length(title) between 1 and 180),
  text_content text,
  storage_path text unique,
  original_filename text,
  mime_type text,
  file_size bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz,
  check ((type = 'text' and text_content is not null and storage_path is null and file_size is null)
      or (type = 'file' and text_content is null and storage_path is not null and original_filename is not null and mime_type is not null and file_size > 0)),
  check (expires_at >= created_at)
);

create table public.rate_limit_events (
  id uuid primary key default gen_random_uuid(),
  action public.rate_limit_action not null,
  ip_hash text not null,
  device_fingerprint_hash text,
  created_at timestamptz not null default now()
);

create index transfer_spaces_expiry_idx on public.transfer_spaces (expires_at) where status = 'active';
create index pairing_codes_lookup_code_idx on public.pairing_codes (code_hash) where used_at is null;
create index pairing_codes_expiry_idx on public.pairing_codes (expires_at) where used_at is null;
create index paired_devices_space_active_idx on public.paired_devices (transfer_space_id) where revoked_at is null;
create index paired_devices_user_active_idx on public.paired_devices (anonymous_user_id) where revoked_at is null;
create index transfer_items_space_created_idx on public.transfer_items (transfer_space_id, created_at desc) where deleted_at is null;
create index rate_limit_events_lookup_idx on public.rate_limit_events (action, ip_hash, created_at desc);

-- Security-definer checks avoid recursive RLS queries. They only return a boolean for auth.uid().
create or replace function public.is_space_owner(space_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.transfer_spaces
    where id = space_id and owner_anonymous_user_id = auth.uid() and status = 'active' and expires_at > now()
  );
$$;

create or replace function public.is_active_paired_device(space_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.paired_devices d
    join public.transfer_spaces s on s.id = d.transfer_space_id
    where d.transfer_space_id = space_id and d.anonymous_user_id = auth.uid()
      and d.revoked_at is null and s.status = 'active' and s.expires_at > now()
  );
$$;

create or replace function public.space_used_bytes(space_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(file_size), 0)::bigint from public.transfer_items
  where transfer_space_id = space_id and type = 'file' and deleted_at is null;
$$;

-- This serializes consumption and device-cap enforcement, preventing two callers from using one code.
create or replace function public.claim_pairing_code(
  p_pairing_code_id uuid,
  p_anonymous_user_id uuid,
  p_device_name text,
  p_device_type public.quickdrop_device_type,
  p_device_token_hash text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_space_id uuid;
  v_device_id uuid;
begin
  select p.transfer_space_id into v_space_id from public.pairing_codes p where p.id = p_pairing_code_id for update;
  if v_space_id is null then raise exception 'pairing_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_space_id::text, 0));
  if not exists (
    select 1 from public.pairing_codes p join public.transfer_spaces s on s.id = p.transfer_space_id
    where p.id = p_pairing_code_id and p.used_at is null and p.expires_at > now()
      and p.failed_attempts < p.max_attempts and s.status = 'active' and s.expires_at > now()
  ) then raise exception 'pairing_invalid'; end if;
  if (select count(*) from public.paired_devices where transfer_space_id = v_space_id and revoked_at is null) >= 3 then
    raise exception 'device_limit';
  end if;
  update public.pairing_codes set used_at = now() where id = p_pairing_code_id and used_at is null;
  insert into public.paired_devices (transfer_space_id, anonymous_user_id, device_name, device_type, device_token_hash)
  values (v_space_id, p_anonymous_user_id, p_device_name, p_device_type, p_device_token_hash)
  returning id into v_device_id;
  return v_device_id;
end;
$$;

create or replace function public.record_pairing_failure(p_pairing_code_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.pairing_codes
  set failed_attempts = least(max_attempts, failed_attempts + 1),
      used_at = case when failed_attempts + 1 >= max_attempts then now() else used_at end
  where id = p_pairing_code_id and used_at is null;
end;
$$;

-- File completion is also serialized so concurrent signed uploads cannot exceed the 2GB space cap.
create or replace function public.create_transfer_file_item(
  p_space_id uuid,
  p_uploader_device_id uuid,
  p_uploader_user_id uuid,
  p_title text,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_file_size bigint
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_expires_at timestamptz;
  v_item_id uuid;
begin
  select expires_at into v_expires_at from public.transfer_spaces
  where id = p_space_id and status = 'active' and expires_at > now() for update;
  if v_expires_at is null then raise exception 'space_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_space_id::text, 1));
  if public.space_used_bytes(p_space_id) + p_file_size > 2147483648 then raise exception 'space_capacity_exceeded'; end if;
  insert into public.transfer_items (transfer_space_id, uploader_device_id, uploader_anonymous_user_id, type, title, storage_path, original_filename, mime_type, file_size, expires_at)
  values (p_space_id, p_uploader_device_id, p_uploader_user_id, 'file', p_title, p_storage_path, p_original_filename, p_mime_type, p_file_size, v_expires_at)
  returning id into v_item_id;
  return v_item_id;
end;
$$;

revoke all on function public.claim_pairing_code(uuid, uuid, text, public.quickdrop_device_type, text) from public, anon, authenticated;
revoke all on function public.record_pairing_failure(uuid) from public, anon, authenticated;
revoke all on function public.create_transfer_file_item(uuid, uuid, uuid, text, text, text, text, bigint) from public, anon, authenticated;

alter table public.transfer_spaces enable row level security;
alter table public.pairing_codes enable row level security;
alter table public.paired_devices enable row level security;
alter table public.transfer_items enable row level security;
alter table public.rate_limit_events enable row level security;

-- No direct client writes: Edge Functions use service_role after checking anonymous identity/device proof.
create policy "owner reads own active spaces" on public.transfer_spaces for select to authenticated
  using (owner_anonymous_user_id = auth.uid());
create policy "owner reads paired devices" on public.paired_devices for select to authenticated
  using (public.is_space_owner(transfer_space_id));
create policy "device reads own pairing" on public.paired_devices for select to authenticated
  using (anonymous_user_id = auth.uid() and revoked_at is null);
create policy "authorized identities read active items" on public.transfer_items for select to authenticated
  using (deleted_at is null and (public.is_space_owner(transfer_space_id) or public.is_active_paired_device(transfer_space_id)));

-- Private Storage: storage.objects is already RLS-protected and owned by Supabase's
-- internal storage role, so hosted projects cannot alter it or add policies from a
-- migration. We deliberately create no client storage policies; Edge Functions issue
-- signed URLs only and the bucket remains private.
insert into storage.buckets (id, name, public, file_size_limit)
values ('quickdrop-files', 'quickdrop-files', false, 2147483648)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

alter publication supabase_realtime add table public.transfer_items;
alter publication supabase_realtime add table public.paired_devices;
