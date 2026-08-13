import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { requireSpaceAccess, admin } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    if (typeof body.transferSpaceId !== 'string' || typeof body.transferItemId !== 'string') return error('请求参数无效。', 400, 'INVALID_INPUT');
    const access = await requireSpaceAccess(request, body.transferSpaceId);
    const { data: item } = await admin.from('transfer_items').select('id, storage_path, uploader_device_id, uploader_anonymous_user_id, deleted_at').eq('id', body.transferItemId).eq('transfer_space_id', body.transferSpaceId).maybeSingle();
    if (!item || item.deleted_at) return error('传输项不存在。', 404, 'ITEM_NOT_FOUND');
    const permitted = access.role === 'owner' || (access.role === 'device' && item.uploader_device_id === access.deviceId && item.uploader_anonymous_user_id === access.userId);
    if (!permitted) return error('仅可删除自己上传的传输项。', 403, 'DELETE_FORBIDDEN');
    if (item.storage_path) { const { error: removeError } = await admin.storage.from('quickdrop-files').remove([item.storage_path]); if (removeError) throw removeError; }
    const { error: deleteError } = await admin.from('transfer_items').update({ deleted_at: new Date().toISOString() }).eq('id', item.id);
    if (deleteError) throw deleteError;
    return json({ ok: true });
  } catch (caught) { return error(caught instanceof Error ? caught.message : '删除失败。', 400, 'DELETE_ITEM_FAILED'); }
});
