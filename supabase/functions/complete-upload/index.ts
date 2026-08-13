import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { admin, requireSpaceAccess } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    const spaceId = typeof body.transferSpaceId === 'string' ? body.transferSpaceId : '';
    const storagePath = typeof body.storagePath === 'string' ? body.storagePath : '';
    const filename = typeof body.filename === 'string' ? body.filename.slice(0, 180) : '';
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType.slice(0, 160) : '';
    const expectedSize = typeof body.size === 'number' ? body.size : 0;
    if (!spaceId || !storagePath.startsWith(`${spaceId}/`) || !filename || !mimeType || !Number.isSafeInteger(expectedSize)) return error('上传确认参数无效。', 400, 'INVALID_INPUT');
    const access = await requireSpaceAccess(request, spaceId);
    const { data: object, error: objectError } = await admin.schema('storage').from('objects').select('metadata').eq('bucket_id', 'quickdrop-files').eq('name', storagePath).maybeSingle();
    if (objectError || !object) { await admin.storage.from('quickdrop-files').remove([storagePath]); return error('找不到已上传的文件。', 404, 'OBJECT_NOT_FOUND'); }
    const metadata = object.metadata as { size?: number; mimetype?: string } | null;
    if (Number(metadata?.size) !== expectedSize || metadata?.mimetype !== mimeType) { await admin.storage.from('quickdrop-files').remove([storagePath]); return error('文件元数据不匹配。', 400, 'UPLOAD_MISMATCH'); }
    const { data: itemId, error: insertError } = await admin.rpc('create_transfer_file_item', { p_space_id: spaceId, p_uploader_device_id: access.deviceId, p_uploader_user_id: access.userId, p_title: filename, p_storage_path: storagePath, p_original_filename: filename, p_mime_type: mimeType, p_file_size: expectedSize });
    if (insertError) { await admin.storage.from('quickdrop-files').remove([storagePath]); throw insertError; }
    return json({ itemId });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '上传确认失败。';
    return error(message, 400, 'COMPLETE_UPLOAD_FAILED');
  }
});
