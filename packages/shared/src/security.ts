export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_SPACE_TTL_MS = 24 * 60 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX_ATTEMPTS = 5;
export const MAX_PAIRED_MOBILES = 3;
export const DEVICE_TOKEN_BYTES = 32; // 256 bits

export type PairingCodeState = {
  expiresAt: Date;
  usedAt: Date | null;
  failedAttempts: number;
  maxAttempts: number;
};

export function isPairingCodeUsable(state: PairingCodeState, now = new Date()): boolean {
  return state.usedAt === null && state.expiresAt.getTime() > now.getTime() && state.failedAttempts < state.maxAttempts;
}

export function nextFailure(state: PairingCodeState, now = new Date()): PairingCodeState {
  const failedAttempts = Math.min(state.maxAttempts, state.failedAttempts + 1);
  return { ...state, failedAttempts, usedAt: failedAttempts >= state.maxAttempts ? now : state.usedAt };
}

export function consumePairingCode(state: PairingCodeState, now = new Date()): PairingCodeState {
  if (!isPairingCodeUsable(state, now)) throw new Error('PAIRING_CODE_UNUSABLE');
  return { ...state, usedAt: now };
}

export function isRateLimited(timestamps: readonly Date[], now = new Date()): boolean {
  const since = now.getTime() - RATE_LIMIT_WINDOW_MS;
  return timestamps.filter((time) => time.getTime() >= since).length >= RATE_LIMIT_MAX_ATTEMPTS;
}
