import { describe, expect, it } from 'vitest';
import {
  fileHeaderFrameSchema,
  intentSchema,
  parseSignalTopic,
  signalChannel,
  signalMessageSchema,
  textFrameSchema,
  textIntentSchema,
  lanOfferSchema,
  lanUploadRequestSchema,
  isPrivateLanEndpoint,
  P2P_CHUNK_BYTES,
  LOCAL_BRIDGE_MIN_FILE_BYTES,
  MAX_DIRECT_FILE_BYTES,
} from '../src/signaling.js';

const spaceId = '2f1c7a3e-9d54-4b2f-8f6a-1c2b3d4e5f60';
const intentId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('signal topic', () => {
  it('builds the channel name for a space', () => {
    expect(signalChannel(spaceId)).toBe(`qd-signal-${spaceId}`);
  });
  it('parses topics with and without the realtime prefix', () => {
    expect(parseSignalTopic(`qd-signal-${spaceId}`)).toBe(spaceId);
    expect(parseSignalTopic(`realtime:qd-signal-${spaceId}`)).toBe(spaceId);
    expect(parseSignalTopic(`REALTIME:QD-SIGNAL-${spaceId.toUpperCase()}`)).toBe(spaceId);
  });
  it('rejects unrelated topics', () => {
    expect(parseSignalTopic('qd-signal-not-a-uuid')).toBeNull();
    expect(parseSignalTopic(`other:qd-signal-${spaceId}`)).toBeNull();
    expect(parseSignalTopic('qd-signal-')).toBeNull();
    expect(parseSignalTopic('transfer_items')).toBeNull();
  });
});

describe('signaling messages', () => {
  it('accepts a valid file intent', () => {
    const parsed = intentSchema.parse({
      v: 1, type: 'intent', intentId, from: 'web', to: spaceId,
      kind: 'file', meta: { name: '照片.png', size: 12345, mime: 'image/png' },
    });
    expect(parsed.kind).toBe('file');
    if (parsed.kind === 'file') expect(parsed.meta.size).toBe(12345);
  });
  it('accepts a valid text intent', () => {
    const parsed = textIntentSchema.parse({
      v: 1, type: 'intent', intentId, from: spaceId, to: 'web',
      kind: 'text', meta: { length: 42 },
    });
    expect(parsed.meta.length).toBe(42);
  });
  it('rejects intents with mismatched meta', () => {
    expect(() => intentSchema.parse({
      v: 1, type: 'intent', intentId, from: 'web', to: spaceId,
      kind: 'file', meta: { length: 42 },
    })).toThrow();
  });
  it('rejects oversized text intents', () => {
    expect(() => textIntentSchema.parse({
      v: 1, type: 'intent', intentId, from: 'web', to: spaceId,
      kind: 'text', meta: { length: 100_001 },
    })).toThrow();
  });
  it('round-trips every signal type through the union', () => {
    const messages = [
      { v: 1, type: 'hello', from: 'web', at: '2026-08-13T10:00:00.000Z' },
      { v: 1, type: 'intent', intentId, from: 'web', to: spaceId, kind: 'text', meta: { length: 3 } },
      { v: 1, type: 'intent-ack', intentId, from: spaceId, to: 'web' },
      { v: 1, type: 'intent-nack', intentId, from: spaceId, to: 'web', reason: 'busy' },
      { v: 1, type: 'sdp', intentId, from: 'web', to: spaceId, sdp: { type: 'offer', sdp: 'v=0' } },
      { v: 1, type: 'ice', intentId, from: spaceId, to: 'web', candidate: 'candidate:1' },
      { v: 1, type: 'cancel', intentId, from: 'web', to: spaceId },
      { v: 1, type: 'bye', from: 'web' },
      { v: 1, type: 'lan-upload-request', intentId, from: spaceId, to: 'web', meta: { name: 'large.zip', size: 67 * 1024 * 1024, mime: 'application/zip' } },
      { v: 1, type: 'lan-offer', intentId, from: 'web', to: spaceId, direction: 'download', endpoint: 'http://192.168.1.8:47561', token: 'a'.repeat(43), meta: { name: 'large.zip', size: 67 * 1024 * 1024, mime: 'application/zip' }, expiresAt: '2026-08-13T10:10:00.000Z' },
      { v: 1, type: 'lan-ack', intentId, from: spaceId, to: 'web' },
      { v: 1, type: 'lan-complete', intentId, from: spaceId, to: 'web', success: true },
      { v: 1, type: 'lan-cancel', intentId, from: 'web', to: spaceId },
    ];
    for (const message of messages) {
      expect(signalMessageSchema.parse(message)).toMatchObject(message);
    }
  });
});

describe('data frames', () => {
  it('keeps direct browser delivery below the in-memory safety cap', () => {
    expect(MAX_DIRECT_FILE_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_DIRECT_FILE_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024 * 1024);
  });

  it('uses a separate local bridge threshold for large streaming files', () => {
    expect(LOCAL_BRIDGE_MIN_FILE_BYTES).toBe(MAX_DIRECT_FILE_BYTES);
  });

  it('accepts only bounded LAN bridge control data', () => {
    expect(lanUploadRequestSchema.parse({
      v: 1, type: 'lan-upload-request', intentId, from: spaceId, to: 'web',
      meta: { name: 'archive.zip', size: 70 * 1024 * 1024, mime: 'application/zip' },
    }).meta.size).toBe(70 * 1024 * 1024);
    expect(() => lanOfferSchema.parse({
      v: 1, type: 'lan-offer', intentId, from: 'web', to: spaceId, direction: 'download', endpoint: 'https://192.168.1.8:47561', token: 'a'.repeat(43),
      meta: { name: 'archive.zip', size: 1, mime: 'application/zip' }, expiresAt: '2026-08-13T10:10:00.000Z',
    })).toThrow();
    expect(isPrivateLanEndpoint('http://192.168.1.8:47561')).toBe(true);
    expect(isPrivateLanEndpoint('http://8.8.8.8:47561')).toBe(false);
  });

  it('accepts a valid file header frame', () => {
    const parsed = fileHeaderFrameSchema.parse({
      t: 'header', transferId: intentId, name: 'a.bin', size: 1024, mime: 'application/octet-stream',
      chunkSize: P2P_CHUNK_BYTES, sha256: 'a'.repeat(64),
    });
    expect(parsed.chunkSize).toBe(P2P_CHUNK_BYTES);
  });
  it('rejects an invalid sha256', () => {
    expect(() => fileHeaderFrameSchema.parse({
      t: 'header', transferId: intentId, name: 'a.bin', size: 1024, mime: 'application/octet-stream',
      chunkSize: P2P_CHUNK_BYTES, sha256: 'zz',
    })).toThrow();
  });
  it('accepts text frames within the shared length limit', () => {
    expect(textFrameSchema.parse({ t: 'text', transferId: intentId, text: '你好' }).text).toBe('你好');
    expect(() => textFrameSchema.parse({ t: 'text', transferId: intentId, text: 'x'.repeat(100_001) })).toThrow();
  });
});
