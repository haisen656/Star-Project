import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { randomToken, requestIp, secretHash } from '../_shared/crypto.ts';
import { admin, assertRateLimit, requireUser } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const user = await requireUser(request);
    const body = await requestJson(request);
    const code = typeof body.code === 'string' && /^\d{4}$/.test(body.code) ? body.code : undefined;
    const pairingToken = typeof body.pairingToken === 'string' && body.pairingToken.length >= 32 ? body.pairingToken : undefined;
    const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 80) : '';
    const deviceType = body.deviceType === 'ios' || body.deviceType === 'android' ? body.deviceType : null;
    if (Boolean(code) === Boolean(pairingToken) || !deviceName || !deviceType) return error('验证码或二维码内容无效。', 400, 'INVALID_INPUT');
    const ipHash = await secretHash(requestIp(request));
    const fingerprintHash = typeof body.deviceFingerprint === 'string' ? await secretHash(body.deviceFingerprint.slice(0, 256)) : undefined;
    await assertRateLimit('pair_code_attempt', ipHash, fingerprintHash);
    const hash = await secretHash(code ?? pairingToken ?? '');
    const column = code ? 'code_hash' : 'pairing_token_hash';
    const { data: pairing } = await admin.from('pairing_codes').select('id, transfer_space_id, expires_at, used_at, failed_attempts, max_attempts').eq(column, hash).maybeSingle();
    if (!pairing) return error('验证码无效。', 400, 'PAIRING_INVALID');
    if (pairing.used_at) return error('验证码已使用。', 400, 'PAIRING_USED');
    if (new Date(pairing.expires_at) <= new Date()) { await admin.rpc('record_pairing_failure', { p_pairing_code_id: pairing.id }); return error('验证码已过期。', 400, 'PAIRING_EXPIRED'); }
    if (pairing.failed_attempts >= pairing.max_attempts) return error('验证码尝试次数过多，已锁定。', 429, 'PAIRING_LOCKED');
    const deviceAccessToken = randomToken(32);
    const deviceTokenHash = await secretHash(deviceAccessToken);
    const { data: deviceId, error: claimError } = await admin.rpc('claim_pairing_code', {
      p_pairing_code_id: pairing.id, p_anonymous_user_id: user.id, p_device_name: deviceName,
      p_device_type: deviceType, p_device_token_hash: deviceTokenHash,
    });
    if (claimError) {
      if (claimError.message.includes('device_limit')) return error('该电脑已连接 3 台手机。', 409, 'DEVICE_LIMIT');
      await admin.rpc('record_pairing_failure', { p_pairing_code_id: pairing.id });
      return error('验证码无效、已使用或已过期。', 400, 'PAIRING_INVALID');
    }
    return json({ transferSpaceId: pairing.transfer_space_id, deviceId, deviceAccessToken, expiresAt: null });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '配对失败。';
    if (message === 'UNAUTHORIZED') return error('匿名身份无效。', 401, message);
    if (message === 'RATE_LIMITED') return error('尝试过于频繁，请 15 分钟后重试。', 429, message);
    return error(message, 400, 'PAIRING_FAILED');
  }
});
