import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { requireSpaceAccess, admin } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    if (typeof body.transferSpaceId !== 'string') return error('请求参数无效。', 400, 'INVALID_INPUT');
    const access = await requireSpaceAccess(request, body.transferSpaceId);
    const { data: space, error: spaceError } = await admin.from('transfer_spaces').select('id, name, status, expires_at, created_at').eq('id', body.transferSpaceId).single();
    if (spaceError) throw spaceError;
    let devices: unknown[] = [];
    if (access.role === 'owner') {
      const { data, error: deviceError } = await admin.from('paired_devices').select('id, device_name, device_type, paired_at, last_seen_at').eq('transfer_space_id', body.transferSpaceId).is('revoked_at', null).order('paired_at');
      if (deviceError) throw deviceError; devices = data ?? [];
    }
    return json({ space, devices, role: access.role });
  } catch (caught) { return error(caught instanceof Error ? caught.message : '读取空间失败。', 400, 'GET_SPACE_FAILED'); }
});
