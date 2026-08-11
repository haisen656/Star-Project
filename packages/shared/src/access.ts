export type AccessSpace = { status: 'active' | 'expired' | 'destroyed'; expiresAt: Date; ownerId: string };
export type AccessDevice = { anonymousUserId: string; revokedAt: Date | null };

export function canReadSpace(space: AccessSpace, requesterId: string, device: AccessDevice | undefined, now = new Date()): boolean {
  if (space.status !== 'active' || space.expiresAt <= now) return false;
  return requesterId === space.ownerId || (device?.anonymousUserId === requesterId && device.revokedAt === null);
}

export function expiredSpaceIds(spaces: readonly { id: string; expiresAt: Date }[], now = new Date()): string[] {
  return spaces.filter((space) => space.expiresAt <= now).map((space) => space.id);
}

export function isSharedFileDownloadAvailable(input: {
  spaceStatus: AccessSpace['status'];
  spaceExpiresAt: Date;
  itemExpiresAt: Date;
  shareExpiresAt: Date | null;
  deletedAt: Date | null;
}, now = new Date()): boolean {
  return input.spaceStatus === 'active' && input.spaceExpiresAt > now && input.itemExpiresAt > now && input.shareExpiresAt !== null && input.shareExpiresAt > now && input.deletedAt === null;
}
