import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { admin, requireSpaceAccess } from '../_shared/supabase.ts';

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TEXT = 100_000;
const dangerous = /\.(?:ade|adp|app|bat|cmd|com|cpl|dll|exe|hta|jar|jse|lnk|msi|msp|mst|pif|ps1|reg|scr|sct|sh|sys|vbe?|vbs|wsc|wsf|wsh)$/i;
const dangerousMime = /(?:x-msdownload|x-dosexec|x-sh|x-bat|portable-executable)/;
function safeFilename(value: string): string { return (value.split(/[\\/]+/).pop() ?? '').replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 180) || 'file'; }

// Records a transfer item receipt after a successful LAN (WebRTC) delivery.
// P2P receipts carry no cloud bytes: file receipts are metadata only and
// cannot be downloaded or shared afterwards.
Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    const spaceId = typeof body.transferSpaceId === 'string' ? body.transferSpaceId : '';
    if (!spaceId) return error('请求参数无效。', 400, 'INVALID_INPUT');
    const access = await requireSpaceAccess(request, spaceId);
    const { data: space, error: spaceError } = await admin.from('transfer_spaces').select('expires_at').eq('id', spaceId).single();
    if (spaceError) throw spaceError;

    if (body.kind === 'text') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : `文本 · ${new Date().toLocaleString('zh-CN')}`;
      if (!text || text.length > MAX_TEXT) return error('文本为空或超过 100,000 字符。', 400, 'TEXT_REJECTED');
      const { data: item, error: insertError } = await admin.from('transfer_items').insert({ transfer_space_id: spaceId, uploader_device_id: access.deviceId, uploader_anonymous_user_id: access.userId, type: 'text', transport: 'p2p', title, text_content: text, expires_at: space.expires_at }).select().single();
      if (insertError) throw insertError;
      return json({ item });
    }

    const filename = typeof body.originalFilename === 'string' ? safeFilename(body.originalFilename) : '';
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType.toLowerCase().slice(0, 160) : '';
    const size = typeof body.fileSize === 'number' ? body.fileSize : 0;
    if (!filename || !Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES || dangerous.test(filename) || dangerousMime.test(mimeType)) return error('文件类型、名称或大小不符合安全要求。', 400, 'FILE_REJECTED');
    const { data: item, error: insertError } = await admin.from('transfer_items').insert({ transfer_space_id: spaceId, uploader_device_id: access.deviceId, uploader_anonymous_user_id: access.userId, type: 'file', transport: 'p2p', title: filename, original_filename: filename, mime_type: mimeType, file_size: size, expires_at: space.expires_at }).select().single();
    if (insertError) throw insertError;
    return json({ item });
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : '记录局域网直传条目失败。', 400, 'CREATE_P2P_ITEM_FAILED');
  }
});
