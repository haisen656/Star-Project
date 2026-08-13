-- QuickDrop: LAN P2P signaling authorization + p2p transfer item receipts.
-- See docs/lan-p2p-transfer.md.

-- 1. Space membership helper (owner or active paired device), reused by
--    realtime.messages policies below.
create or replace function public.is_space_member(space_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_space_owner(space_id) or public.is_active_paired_device(space_id);
$$;

-- 2. Parse the space id out of a Realtime broadcast topic. Accepts both
--    'qd-signal-<uuid>' and 'realtime:qd-signal-<uuid>' because the stored
--    topic prefix varies across Realtime versions. Channel names cannot
--    contain ':', so the separator is '-'.
create or replace function public.signal_topic_space(topic text)
returns uuid language sql immutable security definer set search_path = public as $$
  select case
    when topic ~* '^(:?realtime:)?qd-signal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (substring(topic from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))::uuid
    else null::uuid
  end;
$$;

-- 3. Realtime Broadcast authorization: only space members may send or receive
--    signaling on a qd-signal channel.
create policy "space members send signaling" on realtime.messages for insert to authenticated
  with check (public.is_space_member(public.signal_topic_space(topic)));
create policy "space members receive signaling" on realtime.messages for select to authenticated
  using (public.is_space_member(public.signal_topic_space(topic)));

-- 4. Transfer items get a transport marker. P2P receipts carry no cloud bytes.
alter table public.transfer_items
  add column transport text not null default 'cloud'
  check (transport in ('cloud', 'p2p'));

-- The original unnamed check constraint is located by its definition text and
-- rebuilt with transport-aware rules (auto-generated constraint names are not
-- portable between environments).
do $$ declare cname text; begin
  select conname into cname from pg_constraint
  where conrelid = 'public.transfer_items'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%text_content%';
  if cname is not null then
    execute format('alter table public.transfer_items drop constraint %I', cname);
  end if;
end $$;

alter table public.transfer_items add constraint transfer_items_type_check check (
  (type = 'text' and text_content is not null and storage_path is null and file_size is null)
  or (type = 'file' and text_content is null and original_filename is not null
      and mime_type is not null and file_size > 0
      and ((transport = 'cloud' and storage_path is not null)
        or (transport = 'p2p' and storage_path is null)))
);

-- 5. The 2GB space cap counts cloud bytes only.
create or replace function public.space_used_bytes(space_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(file_size), 0)::bigint from public.transfer_items
  where transfer_space_id = space_id and type = 'file'
    and storage_path is not null and deleted_at is null;
$$;
