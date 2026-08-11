const encoder = new TextEncoder();

export async function hashPairingSecret(value: string, pepper: string): Promise<string> {
  if (!pepper) throw new Error('A server-side hash pepper is required.');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${pepper}\u0000${value}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyPairingSecret(value: string, hash: string, pepper: string): Promise<boolean> {
  const candidate = await hashPairingSecret(value, pepper);
  if (candidate.length !== hash.length) return false;
  let different = 0;
  for (let index = 0; index < candidate.length; index += 1) different |= candidate.charCodeAt(index) ^ hash.charCodeAt(index);
  return different === 0;
}
