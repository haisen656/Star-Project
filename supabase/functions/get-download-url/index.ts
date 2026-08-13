import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { requireSpaceAccess, admin } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    if (typeof body.transferSpaceId !== 'string' || typeof body.transferItemId !== 'string') return error('请求参数无效。', 400, 'INVALID_INPUT');
    await requireSpaceAccess(request, body.transferSpaceId);
    const { data: item } = await admin.from('transfer_items').select('storage_path, original_filename, type, transport, deleted_at').eq('id', body.transferItemId).eq('transfer_space_id', body.transferSpaceId).maybeSingle();
    if (!item || item.type !== 'file' || item.deleted_at) return error('文件不存在。', 404, 'ITEM_NOT_FOUND');
    if (item.transport !== 'cloud') return error('该文件为局域网直传，未存储于云端。', 400, 'P2P_ITEM_NOT_DOWNLOADABLE');
    if (!item.storage_path) return error('文件不存在。', 404, 'ITEM_NOT_FOUND');
    const { data, error: signedError } = await admin.storage.from('quickdrop-files').createSignedUrl(item.storage_path, 60, { download: item.original_filename ?? undefined });
    if (signedError || !data?.signedUrl) throw signedError ?? new Error('SIGNED_URL_FAILED');
    return json({ url: data.signedUrl, expiresInSeconds: 60 });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '下载链接创建失败。';
    const status = ['UNAUTHORIZED', 'DEVICE_TOKEN_REQUIRED', 'DEVICE_REVOKED', 'SPACE_UNAVAILABLE'].includes(message) ? 403 : 400;
    return error(message, status, message);
  }
});
