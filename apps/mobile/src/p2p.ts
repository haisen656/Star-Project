import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription } from 'react-native-webrtc';
import * as Crypto from 'expo-crypto';
import { sha256 } from 'js-sha256';
import { File, Paths } from 'expo-file-system/next';
import {
  dataFrameSchema,
  HEARTBEAT_INTERVAL_MS,
  MAX_DIRECT_FILE_BYTES,
  P2P_CHUNK_BYTES,
  P2P_CONNECT_TIMEOUT_MS,
  P2P_STALL_TIMEOUT_MS,
  PEER_STALE_MS,
  signalChannel,
  signalMessageSchema,
  type FileHeaderFrame,
  type TransferIntent,
} from '@quickdrop/shared';

export type ReceivedFile = { uri: string; name: string; mime: string; size: number };

export type P2PClientCallbacks = {
  onPeersChange?: (peers: string[]) => void;
  onFileReceived?: (file: ReceivedFile) => void;
  onTextReceived?: (text: string) => void;
};

// react-native-webrtc exposes only the on* handler properties in its type
// declarations, so the events below are typed explicitly instead of relying
// on addEventListener signatures.
type DataChannel = ReturnType<RTCPeerConnection['createDataChannel']>;
type IceCandidateInfo = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
type PendingAck = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type ReceiveState = {
  name: string;
  mime: string;
  size: number;
  expected: string;
  received: number;
  lastProgress: number;
  file: File;
  handle: ReturnType<File['open']>;
  hash: ReturnType<typeof sha256.create>;
};
type Session = {
  intentId: string;
  role: 'sender' | 'receiver';
  target: string;
  pc: RTCPeerConnection;
  dc: DataChannel | null;
  pendingCandidates: IceCandidateInfo[];
  receive?: ReceiveState;
  stallTimer?: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
  complete?: { resolve: () => void; reject: (error: Error) => void };
};

const HIGH_WATER_BYTES = 8 * 1024 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;
const WAIT_DONE_TIMEOUT_MS = P2P_STALL_TIMEOUT_MS;
const STALL_CHECK_INTERVAL_MS = 5_000;
const HASH_PASS_CHUNK_BYTES = 1024 * 1024;

function safeFileName(name: string): string {
  const base = name.replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(-120) || 'quickdrop-file';
  return `qd-${Date.now()}-${base}`;
}

export class P2PClient {
  private client: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private foreground = true;
  private peers = new Map<string, number>();
  private sessions = new Map<string, Session>();
  private pendingAcks = new Map<string, PendingAck>();

  constructor(private readonly spaceId: string, private readonly selfId: string, private readonly callbacks: P2PClientCallbacks = {}) {}

  start(client: SupabaseClient): void {
    if (this.channel) return;
    this.client = client;
    this.channel = client.channel(signalChannel(this.spaceId), { config: { broadcast: { ack: true }, private: true } })
      .on('broadcast', { event: 'message' }, (message) => this.onMessage(message.payload))
      .subscribe();
    const hello = () => {
      if (this.foreground) void this.broadcast({ v: 1, type: 'hello', from: this.selfId, at: new Date().toISOString() });
    };
    hello();
    this.heartbeat = setInterval(hello, HEARTBEAT_INTERVAL_MS);
  }

  setForeground(active: boolean): void {
    this.foreground = active;
    if (!active) {
      // Direct transfer is intentionally foreground-only. This prevents a
      // backgrounded app from receiving arbitrary file bytes and makes the
      // sender take the already implemented private-cloud fallback instead.
      void this.broadcast({ v: 1, type: 'bye', from: this.selfId });
      for (const session of [...this.sessions.values()]) this.teardown(session, new Error('P2P_BACKGROUND'));
      return;
    }
    void this.broadcast({ v: 1, type: 'hello', from: this.selfId, at: new Date().toISOString() });
  }

  stop(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.channel && this.client) { void this.client.removeChannel(this.channel); }
    this.channel = null;
    this.client = null;
    this.peers.clear();
    for (const session of [...this.sessions.values()]) this.teardown(session, new Error('P2P_STOPPED'));
    for (const pending of [...this.pendingAcks.values()]) { clearTimeout(pending.timer); pending.reject(new Error('P2P_STOPPED')); }
    this.pendingAcks.clear();
  }

  activePeers(): string[] {
    const now = Date.now();
    return [...this.peers.entries()].filter(([, seen]) => now - seen <= PEER_STALE_MS).map(([id]) => id);
  }

  isPeerAvailable(peerId: string): boolean {
    const seen = this.peers.get(peerId);
    return seen !== undefined && Date.now() - seen <= PEER_STALE_MS;
  }

  async sendFile(uri: string, name: string, mime: string, size: number, target: string, onProgress?: (percent: number) => void): Promise<void> {
    if (size > MAX_DIRECT_FILE_BYTES) throw new Error('P2P_FILE_TOO_LARGE');
    const file = new File(uri);
    const hash = sha256.create();
    const hashPass = file.open();
    let read = hashPass.readBytes(HASH_PASS_CHUNK_BYTES);
    while (read.length > 0) { hash.update(read); read = hashPass.readBytes(HASH_PASS_CHUNK_BYTES); }
    hashPass.close();
    const session = await this.openSenderSession(target, { kind: 'file', name, size, mime });
    try {
      this.sendControl(session, { t: 'header', transferId: session.intentId, name, size, mime, chunkSize: P2P_CHUNK_BYTES, sha256: hash.hex() });
      const handle = file.open();
      let offset = 0;
      while (offset < size) {
        const dc = session.dc;
        if (!dc || dc.readyState !== 'open') { handle.close(); throw new Error('P2P_CHANNEL_CLOSED'); }
        if (dc.bufferedAmount > HIGH_WATER_BYTES) await this.drain(dc);
        const chunk = handle.readBytes(P2P_CHUNK_BYTES);
        if (chunk.length === 0) break;
        dc.send(chunk.buffer as ArrayBuffer);
        offset += chunk.length;
        onProgress?.(Math.round((offset / size) * 100));
      }
      handle.close();
      await this.waitDone(session);
    } catch (caught) {
      this.teardown(session, caught instanceof Error ? caught : new Error('P2P_TRANSFER_FAILED'));
      throw caught;
    }
    this.teardown(session);
  }

  async sendText(text: string, target: string): Promise<void> {
    const session = await this.openSenderSession(target, { kind: 'text', length: text.length });
    try {
      this.sendControl(session, { t: 'text', transferId: session.intentId, text });
      await this.waitDone(session);
    } catch (caught) {
      this.teardown(session, caught instanceof Error ? caught : new Error('P2P_TRANSFER_FAILED'));
      throw caught;
    }
    this.teardown(session);
  }

  private async openSenderSession(target: string, intent: { kind: 'file'; name: string; size: number; mime: string } | { kind: 'text'; length: number }): Promise<Session> {
    if (!this.isPeerAvailable(target)) throw new Error('P2P_PEER_OFFLINE');
    const intentId = Crypto.randomUUID();
    const pc = new RTCPeerConnection({});
    const dc = pc.createDataChannel('quickdrop', { ordered: true });
    const session: Session = { intentId, role: 'sender', target, pc, dc, pendingCandidates: [] };
    this.sessions.set(intentId, session);
    pc.onicecandidate = (event: { candidate: IceCandidateInfo | null }) => {
      if (!event.candidate) return;
      void this.broadcast({ v: 1, type: 'ice', intentId, from: this.selfId, to: target, candidate: JSON.stringify(event.candidate) });
    };
    this.attachDataChannel(session, dc);
    const ack = this.registerAck(intentId);
    await this.broadcast({ v: 1, type: 'intent', intentId, from: this.selfId, to: target, ...intent });
    try {
      await ack;
    } catch (caught) {
      this.teardown(session, caught instanceof Error ? caught : new Error('P2P_REJECTED'));
      throw caught;
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.broadcast({ v: 1, type: 'sdp', intentId, from: this.selfId, to: target, sdp: { type: 'offer', sdp: offer.sdp ?? '' } });
    await this.waitChannelOpen(session);
    return session;
  }

  private registerAck(intentId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(intentId);
        reject(new Error('P2P_CONNECT_TIMEOUT'));
      }, P2P_CONNECT_TIMEOUT_MS);
      this.pendingAcks.set(intentId, { resolve, reject, timer });
    });
  }

  private waitChannelOpen(session: Session): Promise<void> {
    return new Promise((resolve, reject) => {
      const dc = session.dc;
      if (!dc) { reject(new Error('P2P_CHANNEL_MISSING')); return; }
      const started = Date.now();
      const timer = setInterval(() => {
        if (dc.readyState === 'open') { clearInterval(timer); resolve(); return; }
        if (dc.readyState === 'closed' || Date.now() - started > P2P_CONNECT_TIMEOUT_MS) {
          clearInterval(timer);
          reject(new Error('P2P_CONNECT_TIMEOUT'));
        }
      }, 200);
    });
  }

  private waitDone(session: Session): Promise<void> {
    return new Promise((resolve, reject) => {
      session.complete = { resolve, reject };
      session.stallTimer = setTimeout(() => { if (this.sessions.has(session.intentId)) this.teardown(session, new Error('P2P_STALL_TIMEOUT')); }, WAIT_DONE_TIMEOUT_MS);
    });
  }

  private resolveSend(session: Session): void {
    session.complete?.resolve();
    session.complete = undefined;
  }

  private drain(dc: DataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (dc.readyState !== 'open') { clearInterval(timer); reject(new Error('P2P_CHANNEL_CLOSED')); return; }
        if (dc.bufferedAmount <= LOW_WATER_BYTES) { clearInterval(timer); resolve(); }
      }, 50);
    });
  }

  private sendControl(session: Session, frame: unknown): void {
    const dc = session.dc;
    if (!dc || dc.readyState !== 'open') throw new Error('P2P_CHANNEL_CLOSED');
    dc.send(JSON.stringify(frame));
  }

  private attachDataChannel(session: Session, dc: DataChannel): void {
    session.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onclose = () => this.failSession(session.intentId, new Error('P2P_CHANNEL_CLOSED'));
    dc.onerror = () => this.failSession(session.intentId, new Error('P2P_CHANNEL_ERROR'));
    dc.onmessage = (event: { data: unknown }) => void this.onDataFrame(session, event.data);
  }

  private async onDataFrame(session: Session, data: unknown): Promise<void> {
    if (typeof data === 'string') {
      let parsed: ReturnType<typeof dataFrameSchema.safeParse>;
      try { parsed = dataFrameSchema.safeParse(JSON.parse(data) as unknown); }
      catch { return; }
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.t === 'header') { this.beginReceive(session, frame); return; }
      if (frame.t === 'text') { this.callbacks.onTextReceived?.(frame.text); this.sendControl(session, { t: 'done', transferId: session.intentId, received: frame.text.length }); return; }
      if (frame.t === 'done') { this.resolveSend(session); return; }
      if (frame.t === 'error') { this.failSession(session.intentId, new Error('P2P_RECEIVER_ERROR')); return; }
      return;
    }
    if (session.role !== 'receiver' || !session.receive || !(data instanceof ArrayBuffer)) return;
    if (data.byteLength > P2P_CHUNK_BYTES) {
      this.failSession(session.intentId, new Error('P2P_OVERSIZED_CHUNK'));
      return;
    }
    const state = session.receive;
    if (state.received + data.byteLength > state.size) {
      this.failSession(session.intentId, new Error('P2P_OVERSIZED'));
      return;
    }
    const chunk = new Uint8Array(data);
    state.handle.writeBytes(chunk);
    state.hash.update(chunk);
    state.received += data.byteLength;
    state.lastProgress = Date.now();
    if (state.received < state.size) return;
    state.handle.close();
    if (state.hash.hex() !== state.expected) {
      void state.file.delete();
      this.failSession(session.intentId, new Error('P2P_HASH_MISMATCH'));
      return;
    }
    this.sendControl(session, { t: 'done', transferId: session.intentId, received: state.received });
    this.callbacks.onFileReceived?.({ uri: state.file.uri, name: state.name, mime: state.mime, size: state.size });
    this.teardown(session);
  }

  private beginReceive(session: Session, frame: FileHeaderFrame): void {
    if (session.role !== 'receiver' || session.receive) return;
    if (frame.size > MAX_DIRECT_FILE_BYTES || frame.chunkSize > P2P_CHUNK_BYTES) {
      this.failSession(session.intentId, new Error('P2P_OVERSIZED'));
      return;
    }
    if (session.stallTimer) { clearTimeout(session.stallTimer); session.stallTimer = undefined; }
    // The document directory survives app restarts. A direct-transfer receipt
    // never promises cloud download availability, but the receiving phone must
    // not lose the bytes just because its cache is evicted.
    const file = new File(Paths.document, safeFileName(frame.name));
    if (file.exists) file.delete();
    file.create();
    const handle = file.open();
    session.receive = {
      name: frame.name, mime: frame.mime, size: frame.size, expected: frame.sha256,
      received: 0, lastProgress: Date.now(), file, handle, hash: sha256.create(),
    };
    session.stallTimer = setInterval(() => {
      const state = session.receive;
      if (state && Date.now() - state.lastProgress > P2P_STALL_TIMEOUT_MS) {
        void state.file.delete();
        this.failSession(session.intentId, new Error('P2P_STALL_TIMEOUT'));
      }
    }, STALL_CHECK_INTERVAL_MS);
  }

  private onIntent(message: TransferIntent): void {
    if (message.to !== this.selfId) return;
    if (message.kind === 'file' && message.meta.size > MAX_DIRECT_FILE_BYTES) {
      void this.broadcast({ v: 1, type: 'intent-nack', intentId: message.intentId, from: this.selfId, to: message.from, reason: 'unavailable' });
      return;
    }
    if (this.hasIncomingSession()) {
      void this.broadcast({ v: 1, type: 'intent-nack', intentId: message.intentId, from: this.selfId, to: message.from, reason: 'busy' });
      return;
    }
    const pc = new RTCPeerConnection({});
    const session: Session = { intentId: message.intentId, role: 'receiver', target: message.from, pc, dc: null, pendingCandidates: [] };
    this.sessions.set(message.intentId, session);
    session.stallTimer = setTimeout(() => { if (this.sessions.has(session.intentId) && !session.receive) this.teardown(session, new Error('P2P_CONNECT_TIMEOUT')); }, P2P_CONNECT_TIMEOUT_MS);
    pc.onicecandidate = (event: { candidate: IceCandidateInfo | null }) => {
      if (!event.candidate) return;
      void this.broadcast({ v: 1, type: 'ice', intentId: message.intentId, from: this.selfId, to: message.from, candidate: JSON.stringify(event.candidate) });
    };
    pc.ondatachannel = (event: { channel: DataChannel }) => this.attachDataChannel(session, event.channel);
    void this.broadcast({ v: 1, type: 'intent-ack', intentId: message.intentId, from: this.selfId, to: message.from });
  }

  private hasIncomingSession(): boolean {
    return [...this.sessions.values()].some((session) => session.role === 'receiver');
  }

  private onAck(intentId: string): void {
    const pending = this.pendingAcks.get(intentId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(intentId);
    pending.resolve();
  }

  private onNack(intentId: string, reason: 'busy' | 'unavailable'): void {
    const pending = this.pendingAcks.get(intentId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(intentId);
    pending.reject(new Error(reason === 'busy' ? 'P2P_BUSY' : 'P2P_UNAVAILABLE'));
  }

  private async onSdp(intentId: string, description: { type: 'offer' | 'answer'; sdp: string }): Promise<void> {
    const session = this.sessions.get(intentId);
    if (!session) return;
    try {
      if (description.type === 'offer' && session.role === 'receiver') {
        await session.pc.setRemoteDescription(new RTCSessionDescription(description));
        this.flushCandidates(session);
        const answer = await session.pc.createAnswer();
        await session.pc.setLocalDescription(answer);
        await this.broadcast({ v: 1, type: 'sdp', intentId, from: this.selfId, to: session.target, sdp: { type: 'answer', sdp: answer.sdp ?? '' } });
        return;
      }
      if (description.type === 'answer' && session.role === 'sender') {
        await session.pc.setRemoteDescription(new RTCSessionDescription(description));
        this.flushCandidates(session);
      }
    } catch { this.failSession(intentId, new Error('P2P_SIGNALING_FAILED')); }
  }

  private onIce(intentId: string, candidateJson: string): void {
    const session = this.sessions.get(intentId);
    if (!session) return;
    try {
      const candidate = JSON.parse(candidateJson) as IceCandidateInfo;
      if (session.pc.remoteDescription) void session.pc.addIceCandidate(new RTCIceCandidate(candidate));
      else session.pendingCandidates.push(candidate);
    } catch { /* Ignore malformed candidates. */ }
  }

  private async flushCandidates(session: Session): Promise<void> {
    for (const candidate of session.pendingCandidates.splice(0)) {
      try { await session.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* Ignore stale candidates. */ }
    }
  }

  private failSession(intentId: string, reason: Error): void {
    const session = this.sessions.get(intentId);
    if (!session) return;
    const pending = this.pendingAcks.get(intentId);
    if (pending) { clearTimeout(pending.timer); this.pendingAcks.delete(intentId); pending.reject(reason); }
    this.teardown(session, reason);
  }

  private teardown(session: Session, reason?: Error): void {
    if (session.stallTimer) clearTimeout(session.stallTimer);
    if (reason && session.receive) {
      try { session.receive.handle.close(); } catch { /* The handle may already be closed. */ }
      try { if (session.receive.file.exists) session.receive.file.delete(); } catch { /* Best-effort cleanup of partial bytes. */ }
    }
    if (session.complete) {
      if (reason) session.complete.reject(reason);
      else session.complete.resolve();
      session.complete = undefined;
    }
    if (session.dc) { try { session.dc.close(); } catch { /* Ignore. */ } }
    try { session.pc.close(); } catch { /* Ignore. */ }
    this.sessions.delete(session.intentId);
  }

  private async broadcast(message: unknown): Promise<void> {
    if (!this.channel) return;
    try { await this.channel.send({ type: 'broadcast', event: 'message', payload: message }); }
    catch { /* Send failures are non-fatal; transfers fall back to cloud. */ }
  }

  private onMessage(payload: unknown): void {
    if (!this.foreground) return;
    const parsed = signalMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case 'hello':
        if (message.from !== this.selfId) {
          this.peers.set(message.from, Date.now());
          this.callbacks.onPeersChange?.(this.activePeers());
        }
        return;
      case 'intent': this.onIntent(message); return;
      case 'intent-ack': this.onAck(message.intentId); return;
      case 'intent-nack': this.onNack(message.intentId, message.reason); return;
      case 'sdp': void this.onSdp(message.intentId, message.sdp); return;
      case 'ice': this.onIce(message.intentId, message.candidate); return;
      case 'cancel': this.failSession(message.intentId, new Error('P2P_CANCELLED')); return;
      case 'bye':
        if (message.from !== this.selfId) {
          this.peers.delete(message.from);
          this.callbacks.onPeersChange?.(this.activePeers());
        }
        return;
    }
  }
}
