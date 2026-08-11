import { z } from 'zod';

/* eslint-disable no-control-regex -- filenames must reject ASCII control bytes. */

export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SPACE_BYTES = MAX_FILE_BYTES;
export const MAX_FILENAME_LENGTH = 180;
export const MAX_TEXT_LENGTH = 100_000;

const forbiddenExtensions = new Set([
  'ade', 'adp', 'app', 'bat', 'cmd', 'com', 'cpl', 'dll', 'exe', 'hta', 'inf', 'ins', 'isp', 'jar',
  'jse', 'lib', 'lnk', 'msc', 'msi', 'msp', 'mst', 'pif', 'ps1', 'reg', 'scr', 'sct', 'sh', 'sys',
  'vb', 'vbe', 'vbs', 'wsc', 'wsf', 'wsh',
]);
const forbiddenMimeTypes = new Set([
  'application/x-msdownload', 'application/x-dosexec', 'application/x-sh', 'application/x-bat',
  'application/vnd.microsoft.portable-executable',
]);

export function sanitizeFilename(input: string): string {
  const basename = (input.split(/[\\/]+/).pop() ?? '').replace(/[\x00-\x1f<>:"|?*]/g, '_').trim();
  const collapsed = basename.replace(/\s+/g, ' ').replace(/^\.+/, '');
  return (collapsed || 'file').slice(0, MAX_FILENAME_LENGTH);
}

export function fileExtension(filename: string): string {
  const pieces = filename.toLowerCase().split('.');
  return pieces.length > 1 ? pieces.at(-1) ?? '' : '';
}

export function validateFileMetadata(input: { filename: string; mimeType: string; size: number }):
  { valid: true; filename: string } | { valid: false; reason: string } {
  const filename = sanitizeFilename(input.filename);
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_FILE_BYTES) return { valid: false, reason: '文件大小必须介于 1 字节和 2GB 之间。' };
  if (filename.length === 0 || filename.length > MAX_FILENAME_LENGTH) return { valid: false, reason: '文件名长度无效。' };
  if (forbiddenExtensions.has(fileExtension(filename))) return { valid: false, reason: '不允许上传可执行或危险文件类型。' };
  if (!input.mimeType || forbiddenMimeTypes.has(input.mimeType.toLowerCase())) return { valid: false, reason: '不允许的 MIME 类型。' };
  return { valid: true, filename };
}

export const createSpaceSchema = z.object({
  name: z.string().trim().max(80).optional(),
  expiresInHours: z.union([z.literal(1), z.literal(24), z.literal(168)]).default(24),
  deviceFingerprint: z.string().trim().min(8).max(256).optional(),
});
export const pairDeviceSchema = z.object({
  code: z.string().regex(/^\d{4}$/).optional(),
  pairingToken: z.string().min(32).max(512).optional(),
  deviceName: z.string().trim().min(1).max(80),
  deviceType: z.enum(['ios', 'android']),
  deviceFingerprint: z.string().trim().min(8).max(256).optional(),
}).refine((data) => Boolean(data.code) !== Boolean(data.pairingToken), { message: '必须提供验证码或二维码配对令牌之一。' });
export const uploadRequestSchema = z.object({ transferSpaceId: z.string().uuid(), filename: z.string().min(1).max(512), mimeType: z.string().min(1).max(160), size: z.number().int().positive() });
export const completeUploadSchema = z.object({ transferSpaceId: z.string().uuid(), storagePath: z.string().min(1).max(512), filename: z.string().min(1).max(MAX_FILENAME_LENGTH), mimeType: z.string().min(1).max(160), size: z.number().int().positive() });
export const createTextSchema = z.object({ transferSpaceId: z.string().uuid(), text: z.string().trim().min(1).max(MAX_TEXT_LENGTH), title: z.string().trim().max(120).optional() });
