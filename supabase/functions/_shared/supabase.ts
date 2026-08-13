import { createClient, type User } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
if (!url || !anonKey || !serviceRoleKey) throw new Error('Supabase environment is incomplete');

export const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

export async function requireUser(request: Request): Promise<User> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new Error('UNAUTHORIZED');
  const client = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user || data.user.is_anonymous !== true) throw new Error('UNAUTHORIZED');
  return data.user;
}

export type SpaceAccess = { role: 'owner' | 'device'; deviceId: string | null; userId: string };
export async function requireSpaceAccess(request: Request, spaceId: string): Promise<SpaceAccess> {
  const user = await requireUser(request);
  const { data: space } = await admin.from('transfer_spaces').select('id, owner_anonymous_user_id, status, expires_at').eq('id', spaceId).maybeSingle();
  if (!space || space.status !== 'active' || new Date(space.expires_at) <= new Date()) throw new Error('SPACE_UNAVAILABLE');
  if (space.owner_anonymous_user_id === user.id) return { role: 'owner', deviceId: null, userId: user.id };
  const token = request.headers.get('x-device-access-token');
  if (!token || token.length < 40) throw new Error('DEVICE_TOKEN_REQUIRED');
  const tokenHash = await (await import('./crypto.ts')).secretHash(token);
  const { data: device } = await admin.from('paired_devices').select('id').eq('transfer_space_id', spaceId).eq('anonymous_user_id', user.id).eq('device_token_hash', tokenHash).is('revoked_at', null).maybeSingle();
  if (!device) throw new Error('DEVICE_REVOKED');
  await admin.from('paired_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id);
  return { role: 'device', deviceId: device.id, userId: user.id };
}

export async function assertRateLimit(action: 'create_space' | 'pair_code_attempt' | 'upload', ipHash: string, fingerprintHash?: string): Promise<void> {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { count, error } = await admin.from('rate_limit_events').select('*', { count: 'exact', head: true }).eq('action', action).eq('ip_hash', ipHash).gte('created_at', since);
  if (error) throw error;
  if ((count ?? 0) >= 5) throw new Error('RATE_LIMITED');
  const { error: insertError } = await admin.from('rate_limit_events').insert({ action, ip_hash: ipHash, device_fingerprint_hash: fingerprintHash ?? null });
  if (insertError) throw insertError;
}
