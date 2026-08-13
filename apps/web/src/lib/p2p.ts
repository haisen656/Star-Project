import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
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

export type ReceivedFile = { name: string; mime: string; size: number; blob: Blob };

export type P2PClientCallbacks = {
  onPeersChange?: (peers: string[]) => void;
  onFileReceived?: (file: ReceivedFile) => void;
  onTextReceived?: (text: string) => void;
};

type PendingAck = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type ReceiveState = { name: string; mime: string; size: number; sha256: string; chunks: Uint8Array[]; received: number; lastProgress: number };
type Session = {
  intentId: string;
  role: 'sender' | 'receiver';
  target: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  pendingCandidates: RTCIceCandidateInit[];
  receive?: ReceiveState;
  stallTimer?: ReturnType<typeof setInterval>;
  complete?: { resolve: () => void; reject: (error: Error) => void };
};

const HIGH_WATER_BYTES = 8 * 1024 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;
const WAIT_DONE_TIMEOUT_MS = P2P_STALL_TIMEOUT_MS;
const STALL_CHECK_INTERVAL_MS = 5_000;

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export class P2PClient {
  private client: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
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
    const hello = () => void this.broadcast({ v: 1, type: 'hello', from: this.selfId, at: new Date().toISOString() });
    hello();
    this.heartbeat = setInterval(hello, HEARTBEAT_INTERVAL_MS);
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

  async sendFile(file: File, target: string, onProgress?: (percent: number) => void): Promise<void> {
    const size = file.size;
    if (size > MAX_DIRECT_FILE_BYTES) throw new Error('P2P_FILE_TOO_LARGE');
    const name = file.name || 'file';
    const mime = file.type || 'application/octet-stream';
    const buffer = await file.arrayBuffer();
    const hash = await sha256Hex(buffer);
    const session = await this.openSenderSession(target, { kind: 'file', name, size, mime });
    try {
      this.sendControl(session, { t: 'header', transferId: session.intentId, name, size, mime, chunkSize: P2P_CHUNK_BYTES, sha256: hash });
      let offset = 0;
      while (offset < size) {
        const dc = session.dc;
        if (!dc || dc.readyState !== 'open') throw new Error('P2P_CHANNEL_CLOSED');
        if (dc.bufferedAmount > HIGH_WATER_BYTES) await this.drain(dc);
        const end = Math.min(offset + P2P_CHUNK_BYTES, size);
        dc.send(buffer.slice(offset, end));
        offset = end;
        onProgress?.(Math.round((offset / size) * 100));
      }
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
    const intentId = crypto.randomUUID();
    const pc = new RTCPeerConnection();
    const dc = pc.createDataChannel('quickdrop', { ordered: true });
    const session: Session = { intentId, role: 'sender', target, pc, dc, pendingCandidates: [] };
    this.sessions.set(intentId, session);
    pc.onicecandidate = (event) => { if (event.candidate) void this.broadcast({ v: 1, type: 'ice', intentId, from: this.selfId, to: target, candidate: JSON.stringify(event.candidate.toJSON()) }); };
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
      if (dc.readyState === 'open') { resolve(); return; }
      const timer = setTimeout(() => reject(new Error('P2P_CONNECT_TIMEOUT')), P2P_CONNECT_TIMEOUT_MS);
      const onOpen = () => { clearTimeout(timer); resolve(); };
      const onFail = () => { clearTimeout(timer); reject(new Error('P2P_CHANNEL_CLOSED')); };
      dc.addEventListener('open', onOpen, { once: true });
      dc.addEventListener('close', onFail, { once: true });
      dc.addEventListener('error', onFail, { once: true });
    });
  }

  private waitDone(session: Session): Promise<void> {
    return new Promise((resolve, reject) => {
      session.complete = { resolve, reject };
      const timer = setTimeout(() => { if (this.sessions.has(session.intentId)) this.teardown(session, new Error('P2P_STALL_TIMEOUT')); }, WAIT_DONE_TIMEOUT_MS);
      session.stallTimer = timer;
    });
  }

  private resolveSend(session: Session): void {
    session.complete?.resolve();
    session.complete = undefined;
  }

  private drain(dc: RTCDataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (dc.bufferedAmount <= LOW_WATER_BYTES) {
          dc.removeEventListener('bufferedamountlow', check);
          dc.removeEventListener('close', fail);
          resolve();
        }
      };
      const fail = () => {
        dc.removeEventListener('bufferedamountlow', check);
        dc.removeEventListener('close', fail);
        reject(new Error('P2P_CHANNEL_CLOSED'));
      };
      dc.addEventListener('bufferedamountlow', check);
      dc.addEventListener('close', fail, { once: true });
      check();
    });
  }

  private sendControl(session: Session, frame: unknown): void {
    const dc = session.dc;
    if (!dc || dc.readyState !== 'open') throw new Error('P2P_CHANNEL_CLOSED');
    dc.send(JSON.stringify(frame));
  }

  private attachDataChannel(session: Session, dc: RTCDataChannel): void {
    session.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onclose = () => this.failSession(session.intentId, new Error('P2P_CHANNEL_CLOSED'));
    dc.onerror = () => this.failSession(session.intentId, new Error('P2P_CHANNEL_ERROR'));
    dc.onmessage = (event) => void this.onDataFrame(session, event.data);
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
      void this.broadcastError(session);
      this.failSession(session.intentId, new Error('P2P_OVERSIZED_CHUNK'));
      return;
    }
    const state = session.receive;
    if (state.received + data.byteLength > state.size) {
      void this.broadcastError(session);
      this.failSession(session.intentId, new Error('P2P_OVERSIZED'));
      return;
    }
    state.chunks.push(new Uint8Array(data));
    state.received += data.byteLength;
    state.lastProgress = Date.now();
    if (state.received < state.size) return;
    const combined = new Uint8Array(state.size);
    let offset = 0;
    for (const chunk of state.chunks) { combined.set(chunk, offset); offset += chunk.length; }
    state.chunks = [];
    const hash = await sha256Hex(combined.buffer);
    if (hash !== state.sha256) {
      void this.broadcastError(session);
      this.failSession(session.intentId, new Error('P2P_HASH_MISMATCH'));
      return;
    }
    this.sendControl(session, { t: 'done', transferId: session.intentId, received: state.received });
    this.callbacks.onFileReceived?.({ name: state.name, mime: state.mime, size: state.size, blob: new Blob([combined.buffer], { type: state.mime }) });
    this.teardown(session);
  }

  private beginReceive(session: Session, frame: FileHeaderFrame): void {
    if (session.role !== 'receiver' || session.receive) return;
    if (frame.size > MAX_DIRECT_FILE_BYTES || frame.chunkSize > P2P_CHUNK_BYTES) {
      void this.broadcastError(session);
      this.failSession(session.intentId, new Error('P2P_OVERSIZED'));
      return;
    }
    if (session.stallTimer) { clearTimeout(session.stallTimer); session.stallTimer = undefined; }
    session.receive = { name: frame.name, mime: frame.mime, size: frame.size, sha256: frame.sha256, chunks: [], received: 0, lastProgress: Date.now() };
    session.stallTimer = setInterval(() => {
      const state = session.receive;
      if (state && Date.now() - state.lastProgress > P2P_STALL_TIMEOUT_MS) {
        void this.broadcastError(session);
        this.failSession(session.intentId, new Error('P2P_STALL_TIMEOUT'));
      }
    }, STALL_CHECK_INTERVAL_MS);
  }

  private async broadcastError(session: Session): Promise<void> {
    await this.broadcast({ v: 1, type: 'cancel', intentId: session.intentId, from: this.selfId, to: session.target });
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
    const pc = new RTCPeerConnection();
    const session: Session = { intentId: message.intentId, role: 'receiver', target: message.from, pc, dc: null, pendingCandidates: [] };
    this.sessions.set(message.intentId, session);
    session.stallTimer = setTimeout(() => { if (this.sessions.has(session.intentId) && !session.receive) this.teardown(session, new Error('P2P_CONNECT_TIMEOUT')); }, P2P_CONNECT_TIMEOUT_MS);
    pc.onicecandidate = (event) => { if (event.candidate) void this.broadcast({ v: 1, type: 'ice', intentId: message.intentId, from: this.selfId, to: message.from, candidate: JSON.stringify(event.candidate.toJSON()) }); };
    pc.ondatachannel = (event) => this.attachDataChannel(session, event.channel);
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
        await session.pc.setRemoteDescription(description);
        this.flushCandidates(session);
        const answer = await session.pc.createAnswer();
        await session.pc.setLocalDescription(answer);
        await this.broadcast({ v: 1, type: 'sdp', intentId, from: this.selfId, to: session.target, sdp: { type: 'answer', sdp: answer.sdp ?? '' } });
        return;
      }
      if (description.type === 'answer' && session.role === 'sender') {
        await session.pc.setRemoteDescription(description);
        this.flushCandidates(session);
      }
    } catch { this.failSession(intentId, new Error('P2P_SIGNALING_FAILED')); }
  }

  private onIce(intentId: string, candidateJson: string): void {
    const session = this.sessions.get(intentId);
    if (!session) return;
    try {
      const candidate = JSON.parse(candidateJson) as RTCIceCandidateInit;
      if (session.pc.remoteDescription) void session.pc.addIceCandidate(candidate);
      else session.pendingCandidates.push(candidate);
    } catch { /* Ignore malformed candidates. */ }
  }

  private async flushCandidates(session: Session): Promise<void> {
    for (const candidate of session.pendingCandidates.splice(0)) {
      try { await session.pc.addIceCandidate(candidate); } catch { /* Ignore stale candidates. */ }
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
    if (session.stallTimer) clearInterval(session.stallTimer);
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
