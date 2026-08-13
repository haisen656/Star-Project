import { describe, expect, it } from 'vitest';
import { canReadSpace, expiredSpaceIds, hashPairingSecret, isSharedFileDownloadAvailable, verifyPairingSecret } from '../src/index.js';

describe('hashed pairing secrets', () => {
  it('hashes and verifies a code without keeping plaintext', async () => {
    const hash = await hashPairingSecret('4821', 'test-pepper-that-is-long-enough');
    expect(hash).not.toContain('4821');
    await expect(verifyPairingSecret('4821', hash, 'test-pepper-that-is-long-enough')).resolves.toBe(true);
    await expect(verifyPairingSecret('4822', hash, 'test-pepper-that-is-long-enough')).resolves.toBe(false);
  });
});

describe('space lifecycle access', () => {
  const now = new Date('2026-08-06T00:00:00.000Z');
  it('selects expired spaces for cleanup', () => expect(expiredSpaceIds([{ id: 'old', expiresAt: new Date(now.getTime() - 1) }, { id: 'new', expiresAt: new Date(now.getTime() + 1) }], now)).toEqual(['old']));
  it('does not allow a revoked device to access an active space', () => {
    const space = { status: 'active' as const, expiresAt: new Date(now.getTime() + 1), ownerId: 'owner' };
    expect(canReadSpace(space, 'phone', { anonymousUserId: 'phone', revokedAt: now }, now)).toBe(false);
  });
  it('only makes a non-deleted shared file available before every expiry', () => {
    const valid = { spaceStatus: 'active' as const, spaceExpiresAt: new Date(now.getTime() + 2_000), itemExpiresAt: new Date(now.getTime() + 2_000), shareExpiresAt: new Date(now.getTime() + 1_000), deletedAt: null };
    expect(isSharedFileDownloadAvailable(valid, now)).toBe(true);
    expect(isSharedFileDownloadAvailable({ ...valid, shareExpiresAt: new Date(now.getTime() - 1) }, now)).toBe(false);
  });
});
