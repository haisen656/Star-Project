import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { admin, requireSpaceAccess } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    const spaceId = typeof body.transferSpaceId === 'string' ? body.transferSpaceId : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : `文本 · ${new Date().toLocaleString('zh-CN')}`;
    if (!spaceId || !text || text.length > 100_000) return error('文本为空或超过 100,000 字符。', 400, 'TEXT_REJECTED');
    const access = await requireSpaceAccess(request, spaceId);
    const { data: space, error: spaceError } = await admin.from('transfer_spaces').select('expires_at').eq('id', spaceId).single();
    if (spaceError) throw spaceError;
    const { data: item, error: insertError } = await admin.from('transfer_items').insert({ transfer_space_id: spaceId, uploader_device_id: access.deviceId, uploader_anonymous_user_id: access.userId, type: 'text', title, text_content: text, expires_at: space.expires_at }).select().single();
    if (insertError) throw insertError;
    return json({ item });
  } catch (caught) { return error(caught instanceof Error ? caught.message : '同步文本失败。', 400, 'CREATE_TEXT_FAILED'); }
});
