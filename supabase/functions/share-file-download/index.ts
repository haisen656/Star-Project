import { corsHeaders, error, handleOptions, json, requestJson } from '../_shared/http.ts';
import { secretHash } from '../_shared/crypto.ts';
import { admin } from '../_shared/supabase.ts';

async function resolveDownload(token: string): Promise<{ url: string; filename: string | null }> {
  if (token.length < 40 || token.length > 512) throw new Error('SHARE_INVALID');
  const { data: item, error: itemError } = await admin.from('transfer_items').select('storage_path, original_filename, type, deleted_at, share_expires_at, transfer_spaces!inner(status, expires_at)').eq('share_token_hash', await secretHash(token)).maybeSingle();
  if (itemError) throw itemError;
  const space = item?.transfer_spaces as unknown as { status: string; expires_at: string } | null;
  if (!item || item.type !== 'file' || item.deleted_at || !item.storage_path || !item.share_expires_at || new Date(item.share_expires_at) <= new Date() || !space || space.status !== 'active' || new Date(space.expires_at) <= new Date()) throw new Error('SHARE_INVALID');
  const { data, error: signedError } = await admin.storage.from('quickdrop-files').createSignedUrl(item.storage_path, 60, { download: item.original_filename ?? undefined });
  if (signedError || !data?.signedUrl) throw signedError ?? new Error('SIGNED_URL_FAILED');
  return { url: data.signedUrl, filename: item.original_filename };
}

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const token = request.method === 'GET' ? new URL(request.url).searchParams.get('token') ?? '' : String((await requestJson(request)).token ?? '');
    const resolved = await resolveDownload(token);
    if (request.method === 'GET') return new Response(null, { status: 302, headers: { ...corsHeaders, Location: resolved.url, 'Cache-Control': 'no-store' } });
    return json({ url: resolved.url, filename: resolved.filename, expiresInSeconds: 60 });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '下载链接无效。';
    return error(message === 'SHARE_INVALID' ? '分享链接无效、已过期或已撤销。' : message, message === 'SHARE_INVALID' ? 404 : 400, message);
  }
});
