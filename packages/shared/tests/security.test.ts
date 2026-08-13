import { describe, expect, it } from 'vitest';
import { consumePairingCode, isPairingCodeUsable, isRateLimited, nextFailure, PAIRING_MAX_ATTEMPTS } from '../src/security.js';

const now = new Date('2026-08-06T00:00:00.000Z');
const valid = () => ({ expiresAt: new Date(now.getTime() + 600_000), usedAt: null, failedAttempts: 0, maxAttempts: PAIRING_MAX_ATTEMPTS });

describe('pairing-code state', () => {
  it('consumes a code once', () => {
    expect(isPairingCodeUsable(valid(), now)).toBe(true);
    expect(isPairingCodeUsable(consumePairingCode(valid(), now), now)).toBe(false);
  });
  it('rejects an expired code', () => expect(isPairingCodeUsable({ ...valid(), expiresAt: new Date(now.getTime() - 1) }, now)).toBe(false));
  it('locks after five failures', () => {
    let state = valid();
    for (let index = 0; index < PAIRING_MAX_ATTEMPTS; index += 1) state = nextFailure(state, now);
    expect(state.usedAt).toEqual(now);
    expect(isPairingCodeUsable(state, now)).toBe(false);
  });
  it('limits five attempts in fifteen minutes', () => {
    const attempts = Array.from({ length: 5 }, (_, index) => new Date(now.getTime() - index * 1000));
    expect(isRateLimited(attempts, now)).toBe(true);
  });
});
