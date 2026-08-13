import { z } from 'zod';
import { MAX_FILE_BYTES, MAX_TEXT_LENGTH } from './validation';

// LAN P2P (WebRTC) signaling protocol. See docs/lan-p2p-transfer.md.
// Signaling messages are tiny control frames exchanged over a Supabase
// Realtime private broadcast channel; file bytes and text payloads always
// travel over the WebRTC DataChannel instead.

export const P2P_PROTOCOL_VERSION = 1;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const PEER_STALE_MS = 22_000;
export const P2P_CONNECT_TIMEOUT_MS = 8_000;
export const P2P_STALL_TIMEOUT_MS = 30_000;
export const P2P_CHUNK_BYTES = 64 * 1024;
// Browser receivers cannot stream a DataChannel directly to the downloads
// folder on every supported browser. Keep v1's in-memory browser handoff
// deliberately bounded; larger files automatically use private Storage.
export const MAX_DIRECT_FILE_BYTES = 64 * 1024 * 1024;
// Files at or above this threshold bypass browser WebRTC.  They use the
// optional Windows bridge, which streams bytes over the local network without
// keeping a browser-sized copy in memory. Smaller files deliberately remain
// in private Supabase Storage so they are available to every paired device.
export const LOCAL_BRIDGE_MIN_FILE_BYTES = MAX_DIRECT_FILE_BYTES;
export const LOCAL_BRIDGE_PORT = 47_561;
export const LOCAL_BRIDGE_HANDSHAKE_TIMEOUT_MS = 12_000;
export const LOCAL_BRIDGE_TOKEN_BYTES = 32;
export const WEB_PEER_ID = 'web';

export function signalChannel(spaceId: string): string {
  // supabase-js channel names only allow [a-zA-Z0-9_-]; the SQL topic policy
  // mirrors this format (public.signal_topic_space).
  return `qd-signal-${spaceId}`;
}

// Pure TypeScript mirror of public.signal_topic_space(); accepts an optional
// 'realtime:' prefix because the stored topic format varies across Realtime
// versions. Returns the lowercase space UUID or null.
export function parseSignalTopic(topic: string): string | null {
  const match = /^(?:realtime:)?qd-signal-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(topic);
  return match ? match[1].toLowerCase() : null;
}

const uuid = z.string().uuid();
const peerId = z.union([z.literal(WEB_PEER_ID), uuid]);

export const helloSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('hello'),
  from: peerId,
  at: z.string().datetime(),
});

const intentBase = {
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('intent'),
  intentId: uuid,
  from: peerId,
  to: peerId,
};

export const fileIntentSchema = z.object({
  ...intentBase,
  kind: z.literal('file'),
  meta: z.object({
    name: z.string().min(1).max(512),
    size: z.number().int().positive().max(MAX_FILE_BYTES),
    mime: z.string().min(1).max(160),
  }),
});

export const textIntentSchema = z.object({
  ...intentBase,
  kind: z.literal('text'),
  meta: z.object({ length: z.number().int().positive().max(MAX_TEXT_LENGTH) }),
});

export const intentSchema = z.discriminatedUnion('kind', [fileIntentSchema, textIntentSchema]);

export const intentAckSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('intent-ack'),
  intentId: uuid,
  from: peerId,
  to: peerId,
});

export const intentNackSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('intent-nack'),
  intentId: uuid,
  from: peerId,
  to: peerId,
  reason: z.enum(['busy', 'unavailable']),
});

export const sdpSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('sdp'),
  intentId: uuid,
  from: peerId,
  to: peerId,
  sdp: z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().min(1) }),
});

export const iceSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('ice'),
  intentId: uuid,
  from: peerId,
  to: peerId,
  candidate: z.string().min(1),
});

export const cancelSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('cancel'),
  intentId: uuid,
  from: peerId,
  to: peerId,
});

export const byeSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('bye'),
  from: peerId,
});

const bridgeMetaSchema = z.object({
  name: z.string().min(1).max(512),
  size: z.number().int().positive().max(MAX_FILE_BYTES),
  mime: z.string().min(1).max(160),
});

// These are control-plane messages only. The endpoint is a LAN address and
// every transfer gets a fresh, memory-only 256-bit bearer token. No bytes or
// credentials are ever sent through Supabase Realtime.
export function isPrivateLanEndpoint(value: string): boolean {
  const match = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{2,5})$/.exec(value);
  if (!match) return false;
  const [, a, b, c, d, port] = match;
  const octets = [a, b, c, d].map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65_535) return false;
  return octets[0] === 10 || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}
const bridgeEndpointSchema = z.string().max(80).refine(isPrivateLanEndpoint, 'Expected a private IPv4 LAN endpoint');
const bridgeTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const lanUploadRequestSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('lan-upload-request'),
  intentId: uuid,
  from: uuid,
  to: z.literal(WEB_PEER_ID),
  meta: bridgeMetaSchema,
});
export const lanOfferSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('lan-offer'),
  intentId: uuid,
  from: z.literal(WEB_PEER_ID),
  to: uuid,
  // download: browser -> phone; upload: phone -> local bridge -> browser.
  direction: z.enum(['download', 'upload']),
  endpoint: bridgeEndpointSchema,
  token: bridgeTokenSchema,
  meta: bridgeMetaSchema,
  expiresAt: z.string().datetime(),
});
export const lanAckSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('lan-ack'),
  intentId: uuid,
  from: uuid,
  to: z.literal(WEB_PEER_ID),
});
export const lanCompleteSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('lan-complete'),
  intentId: uuid,
  from: peerId,
  to: peerId,
  success: z.boolean(),
  error: z.string().min(1).max(160).optional(),
});
export const lanCancelSchema = z.object({
  v: z.literal(P2P_PROTOCOL_VERSION),
  type: z.literal('lan-cancel'),
  intentId: uuid,
  from: peerId,
  to: peerId,
});

export const signalMessageSchema = z.union([
  helloSchema,
  intentSchema,
  intentAckSchema,
  intentNackSchema,
  sdpSchema,
  iceSchema,
  cancelSchema,
  byeSchema,
  lanUploadRequestSchema,
  lanOfferSchema,
  lanAckSchema,
  lanCompleteSchema,
  lanCancelSchema,
]);

// DataChannel frames. String frames are JSON control messages; file bytes
// travel as raw binary frames of P2P_CHUNK_BYTES (the final frame is shorter).
export const fileHeaderFrameSchema = z.object({
  t: z.literal('header'),
  transferId: uuid,
  name: z.string().min(1).max(512),
  size: z.number().int().positive().max(MAX_FILE_BYTES),
  mime: z.string().min(1).max(160),
  chunkSize: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const textFrameSchema = z.object({
  t: z.literal('text'),
  transferId: uuid,
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
});

export const doneFrameSchema = z.object({
  t: z.literal('done'),
  transferId: uuid,
  received: z.number().int().nonnegative(),
});

export const errorFrameSchema = z.object({
  t: z.literal('error'),
  transferId: uuid,
  reason: z.string().min(1).max(200),
});

export const dataFrameSchema = z.discriminatedUnion('t', [
  fileHeaderFrameSchema,
  textFrameSchema,
  doneFrameSchema,
  errorFrameSchema,
]);

export type HelloMessage = z.infer<typeof helloSchema>;
export type TransferIntent = z.infer<typeof intentSchema>;
export type SdpMessage = z.infer<typeof sdpSchema>;
export type IceMessage = z.infer<typeof iceSchema>;
export type SignalMessage = z.infer<typeof signalMessageSchema>;
export type LanOfferMessage = z.infer<typeof lanOfferSchema>;
export type LanUploadRequestMessage = z.infer<typeof lanUploadRequestSchema>;
export type FileHeaderFrame = z.infer<typeof fileHeaderFrameSchema>;
export type TextFrame = z.infer<typeof textFrameSchema>;
export type DataFrame = z.infer<typeof dataFrameSchema>;
