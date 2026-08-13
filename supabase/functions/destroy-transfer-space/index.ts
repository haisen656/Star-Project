import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { requireSpaceAccess, admin } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    if (typeof body.transferSpaceId !== 'string') return error('请求参数无效。', 400, 'INVALID_INPUT');
    const access = await requireSpaceAccess(request, body.transferSpaceId);
    if (access.role !== 'owner') return error('只有空间所有者可以销毁空间。', 403, 'OWNER_REQUIRED');
    const { data: items, error: itemsError } = await admin.from('transfer_items').select('storage_path').eq('transfer_space_id', body.transferSpaceId).not('storage_path', 'is', null);
    if (itemsError) throw itemsError;
    const paths = (items ?? []).flatMap((item) => item.storage_path ? [item.storage_path] : []);
    for (let index = 0; index < paths.length; index += 100) { const { error: removeError } = await admin.storage.from('quickdrop-files').remove(paths.slice(index, index + 100)); if (removeError) throw removeError; }
    const { error: deleteError } = await admin.from('transfer_spaces').delete().eq('id', body.transferSpaceId);
    if (deleteError) throw deleteError;
    return json({ ok: true });
  } catch (caught) { return error(caught instanceof Error ? caught.message : '销毁空间失败。', 400, 'DESTROY_SPACE_FAILED'); }
});
