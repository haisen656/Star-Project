const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function secretHash(value: string): Promise<string> {
  const pepper = Deno.env.get('PAIRING_HASH_SECRET');
  if (!pepper || pepper.length < 32) throw new Error('PAIRING_HASH_SECRET is not configured securely');
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(`${pepper}\u0000${value}`)));
}

export function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function randomFourDigitCode(): string {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return String(1000 + (value[0] % 9000));
}

export function requestIp(request: Request): string {
  return (request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown').trim();
}
