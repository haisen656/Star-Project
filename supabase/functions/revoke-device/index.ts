import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { requireSpaceAccess, admin } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    if (typeof body.transferSpaceId !== 'string' || typeof body.deviceId !== 'string') return error('请求参数无效。', 400, 'INVALID_INPUT');
    const access = await requireSpaceAccess(request, body.transferSpaceId);
    if (access.role !== 'owner') return error('只有网页空间所有者可以移除设备。', 403, 'OWNER_REQUIRED');
    const { data, error: updateError } = await admin.from('paired_devices').update({ revoked_at: new Date().toISOString() }).eq('id', body.deviceId).eq('transfer_space_id', body.transferSpaceId).is('revoked_at', null).select('id').maybeSingle();
    if (updateError) throw updateError;
    if (!data) return error('设备不存在或已被移除。', 404, 'DEVICE_NOT_FOUND');
    return json({ ok: true });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '移除设备失败。';
    return error(message, message === 'UNAUTHORIZED' ? 401 : 400, message);
  }
});
