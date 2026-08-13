-- Explicit, revocable link sharing for individual files. The plaintext token is never persisted.
alter table public.transfer_items
  add column share_token_hash text,
  add column share_expires_at timestamptz;

create unique index transfer_items_share_token_hash_unique
  on public.transfer_items (share_token_hash)
  where share_token_hash is not null;

create index transfer_items_share_lookup_idx
  on public.transfer_items (share_token_hash, share_expires_at)
  where share_token_hash is not null and deleted_at is null;
