import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { randomFourDigitCode, randomToken, secretHash } from '../_shared/crypto.ts';
import { admin, requireSpaceAccess } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const body = await requestJson(request);
    if (typeof body.transferSpaceId !== 'string') return error('请求参数无效。', 400, 'INVALID_INPUT');
    const access = await requireSpaceAccess(request, body.transferSpaceId);
    if (access.role !== 'owner') return error('只有空间所有者可重新生成验证码。', 403, 'OWNER_REQUIRED');
    await admin.from('pairing_codes').update({ used_at: new Date().toISOString() }).eq('transfer_space_id', body.transferSpaceId).is('used_at', null);
    const pairingToken = randomToken(32); const pairingTokenHash = await secretHash(pairingToken);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = randomFourDigitCode();
      const { error: insertError } = await admin.from('pairing_codes').insert({ transfer_space_id: body.transferSpaceId, code_hash: await secretHash(code), pairing_token_hash: pairingTokenHash, expires_at: expiresAt, max_attempts: 5 });
      if (!insertError) return json({ code, pairingToken, pairingExpiresAt: expiresAt, qrPayload: JSON.stringify({ v: 1, pairingToken }) });
      if (insertError.code !== '23505') throw insertError;
    }
    throw new Error('PAIRING_CODE_GENERATION_FAILED');
  } catch (caught) { return error(caught instanceof Error ? caught.message : '生成验证码失败。', 400, 'REGENERATE_FAILED'); }
});
