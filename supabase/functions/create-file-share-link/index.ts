import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { randomToken, secretHash } from '../_shared/crypto.ts';
import { admin, requireSpaceAccess } from '../_shared/supabase.ts';

const SHARE_TTL_MS = 60 * 60 * 1000;

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    if (typeof body.transferSpaceId !== 'string' || typeof body.transferItemId !== 'string') return error('请求参数无效。', 400, 'INVALID_INPUT');
    const access = await requireSpaceAccess(request, body.transferSpaceId);
    const { data: item, error: itemError } = await admin.from('transfer_items').select('id, type, deleted_at, expires_at, uploader_device_id, uploader_anonymous_user_id').eq('id', body.transferItemId).eq('transfer_space_id', body.transferSpaceId).maybeSingle();
    if (itemError) throw itemError;
    if (!item || item.type !== 'file' || item.deleted_at || new Date(item.expires_at) <= new Date()) return error('文件不存在或已过期。', 404, 'ITEM_NOT_FOUND');
    const mayShare = access.role === 'owner' || (access.deviceId === item.uploader_device_id && access.userId === item.uploader_anonymous_user_id);
    if (!mayShare) return error('仅空间所有者或文件上传者可生成分享链接。', 403, 'SHARE_FORBIDDEN');
    const token = randomToken(32);
    const expiresAt = new Date(Math.min(new Date(item.expires_at).getTime(), Date.now() + SHARE_TTL_MS)).toISOString();
    const { error: updateError } = await admin.from('transfer_items').update({ share_token_hash: await secretHash(token), share_expires_at: expiresAt }).eq('id', item.id);
    if (updateError) throw updateError;
    const webAppUrl = Deno.env.get('WEB_APP_URL');
    if (!webAppUrl) throw new Error('WEB_APP_URL is not configured');
    const shareUrl = new URL('/download', webAppUrl); shareUrl.searchParams.set('token', token);
    const directDownloadUrl = new URL('/share-file-download', request.url); directDownloadUrl.searchParams.set('token', token);
    return json({ shareUrl: shareUrl.toString(), directDownloadUrl: directDownloadUrl.toString(), expiresAt });
  } catch (caught) { return error(caught instanceof Error ? caught.message : '创建分享链接失败。', 400, 'CREATE_SHARE_FAILED'); }
});
