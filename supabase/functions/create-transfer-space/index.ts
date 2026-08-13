import { handleOptions, json, error, requestJson } from '../_shared/http.ts';
import { randomFourDigitCode, randomToken, requestIp, secretHash } from '../_shared/crypto.ts';
import { admin, assertRateLimit, requireUser } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  const options = handleOptions(request); if (options) return options;
  try {
    const user = await requireUser(request);
    const body = await requestJson(request);
    const expiresInHours = body.expiresInHours === 1 || body.expiresInHours === 168 ? body.expiresInHours : 24;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : '临时传输空间';
    const ipHash = await secretHash(requestIp(request));
    const fingerprintHash = typeof body.deviceFingerprint === 'string' ? await secretHash(body.deviceFingerprint.slice(0, 256)) : undefined;
    await assertRateLimit('create_space', ipHash, fingerprintHash);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000).toISOString();
    const { data: space, error: spaceError } = await admin.from('transfer_spaces').insert({ owner_anonymous_user_id: user.id, name, expires_at: expiresAt }).select('id, expires_at').single();
    if (spaceError) throw spaceError;
    let code = ''; let codeHash = ''; let inserted = false;
    const pairingToken = randomToken(32);
    const pairingTokenHash = await secretHash(pairingToken);
    const pairingExpiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    for (let attempt = 0; attempt < 12 && !inserted; attempt += 1) {
      code = randomFourDigitCode(); codeHash = await secretHash(code);
      const { error: codeError } = await admin.from('pairing_codes').insert({ transfer_space_id: space.id, code_hash: codeHash, pairing_token_hash: pairingTokenHash, expires_at: pairingExpiresAt, max_attempts: 5 });
      if (!codeError) inserted = true;
      else if (codeError.code !== '23505') throw codeError;
    }
    if (!inserted) { await admin.from('transfer_spaces').delete().eq('id', space.id); throw new Error('PAIRING_CODE_GENERATION_FAILED'); }
    return json({ transferSpaceId: space.id, code, pairingToken, pairingExpiresAt, expiresAt: space.expires_at, qrPayload: JSON.stringify({ v: 1, pairingToken }) });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '创建传输空间失败。';
    if (message === 'UNAUTHORIZED') return error('匿名身份无效，请刷新后重试。', 401, message);
    if (message === 'RATE_LIMITED') return error('创建过于频繁，请 15 分钟后再试。', 429, message);
    return error(message, 400, 'CREATE_SPACE_FAILED');
  }
});
