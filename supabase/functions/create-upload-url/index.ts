import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { randomToken, requestIp, secretHash } from '../_shared/crypto.ts';
import { admin, assertRateLimit, requireSpaceAccess } from '../_shared/supabase.ts';

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const dangerous = /\.(?:ade|adp|app|bat|cmd|com|cpl|dll|exe|hta|jar|jse|lnk|msi|msp|mst|pif|ps1|reg|scr|sct|sh|sys|vbe?|vbs|wsc|wsf|wsh)$/i;
function safeFilename(value: string): string { return (value.split(/[\\/]+/).pop() ?? '').replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 180) || 'file'; }

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    const spaceId = typeof body.transferSpaceId === 'string' ? body.transferSpaceId : '';
    const filename = typeof body.filename === 'string' ? safeFilename(body.filename) : '';
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType.toLowerCase().slice(0, 160) : '';
    const size = typeof body.size === 'number' ? body.size : 0;
    if (!spaceId || !filename || !Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES || dangerous.test(filename) || /(?:x-msdownload|x-dosexec|x-sh|x-bat|portable-executable)/.test(mimeType)) return error('文件类型、名称或大小不符合安全要求。', 400, 'FILE_REJECTED');
    const access = await requireSpaceAccess(request, spaceId);
    await assertRateLimit('upload', await secretHash(requestIp(request)));
    const { data: usedBytes, error: usageError } = await admin.rpc('space_used_bytes', { space_id: spaceId });
    if (usageError) throw usageError;
    if (Number(usedBytes ?? 0) + size > MAX_BYTES) return error('传输空间总容量不能超过 2GB。', 409, 'SPACE_CAPACITY_EXCEEDED');
    const storagePath = `${spaceId}/${randomToken(18)}/${filename}`;
    const { data, error: uploadError } = await admin.storage.from('quickdrop-files').createSignedUploadUrl(storagePath);
    if (uploadError || !data?.signedUrl) throw uploadError ?? new Error('UPLOAD_URL_FAILED');
    return json({ storagePath, signedUrl: data.signedUrl, token: data.token, filename, uploaderDeviceId: access.deviceId });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '上传授权失败。';
    return error(message, ['UNAUTHORIZED', 'DEVICE_TOKEN_REQUIRED', 'DEVICE_REVOKED', 'SPACE_UNAVAILABLE'].includes(message) ? 403 : 400, message);
  }
});
