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

export const signalMessageSchema = z.union([
  helloSchema,
  intentSchema,
  intentAckSchema,
  intentNackSchema,
  sdpSchema,
  iceSchema,
  cancelSchema,
  byeSchema,
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
export type FileHeaderFrame = z.infer<typeof fileHeaderFrameSchema>;
export type TextFrame = z.infer<typeof textFrameSchema>;
export type DataFrame = z.infer<typeof dataFrameSchema>;
