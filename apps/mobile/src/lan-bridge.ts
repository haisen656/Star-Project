import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import { File, Paths } from 'expo-file-system/next';
import {
  LOCAL_BRIDGE_HANDSHAKE_TIMEOUT_MS,
  WEB_PEER_ID,
  signalChannel,
  signalMessageSchema,
  type LanOfferMessage,
} from '@quickdrop/shared';

export type BridgeReceivedFile = { uri: string; name: string; mime: string; size: number };
type FileMeta = { name: string; size: number; mime: string };
type PendingUpload = {
  uri: string;
  meta: FileMeta;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type MobileLanBridgeCallbacks = {
  onFileReceived?: (file: BridgeReceivedFile) => void;
  onStatus?: (message: string) => void;
};

function localFilename(name: string): string {
  return `qd-lan-${Date.now()}-${name.replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(-120) || 'file'}`;
}

function validOffer(offer: LanOfferMessage): boolean {
  return offer.from === WEB_PEER_ID && Date.parse(offer.expiresAt) > Date.now() && /^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}$/.test(offer.endpoint);
}

export class MobileLanBridgeClient {
  private client: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private foreground = true;
  private pendingUploads = new Map<string, PendingUpload>();

  constructor(private readonly spaceId: string, private readonly selfId: string, private readonly callbacks: MobileLanBridgeCallbacks = {}) {}

  start(client: SupabaseClient): void {
    if (this.channel) return;
    this.client = client;
    this.channel = client.channel(signalChannel(this.spaceId), { config: { broadcast: { ack: true }, private: true } })
      .on('broadcast', { event: 'message' }, (message) => void this.onMessage(message.payload))
      .subscribe();
  }

  setForeground(active: boolean): void { this.foreground = active; }

  stop(): void {
    if (this.channel && this.client) void this.client.removeChannel(this.channel);
    this.channel = null; this.client = null;
    for (const [id, pending] of this.pendingUploads) {
      clearTimeout(pending.timer); pending.reject(new Error('LOCAL_BRIDGE_STOPPED')); this.pendingUploads.delete(id);
    }
  }

  sendFile(uri: string, name: string, mime: string, size: number): Promise<void> {
    if (!this.foreground) return Promise.reject(new Error('LOCAL_BRIDGE_BACKGROUND'));
    const intentId = Crypto.randomUUID();
    const meta = { name, mime, size };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUploads.delete(intentId);
        reject(new Error('LOCAL_BRIDGE_UNAVAILABLE'));
      }, LOCAL_BRIDGE_HANDSHAKE_TIMEOUT_MS);
      this.pendingUploads.set(intentId, { uri, meta, resolve, reject, timer });
      void this.broadcast({ v: 1, type: 'lan-upload-request', intentId, from: this.selfId, to: WEB_PEER_ID, meta })
        .catch(() => { clearTimeout(timer); this.pendingUploads.delete(intentId); reject(new Error('LOCAL_BRIDGE_SIGNALING_FAILED')); });
    });
  }

  private async onMessage(payload: unknown): Promise<void> {
    if (!this.foreground) return;
    const parsed = signalMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'lan-offer' && message.to === this.selfId && validOffer(message)) {
      await this.onOffer(message);
      return;
    }
    if (message.type === 'lan-cancel' && message.to === this.selfId) {
      const pending = this.pendingUploads.get(message.intentId);
      if (pending) { clearTimeout(pending.timer); this.pendingUploads.delete(message.intentId); pending.reject(new Error('LOCAL_BRIDGE_UNAVAILABLE')); }
    }
  }

  private async onOffer(offer: LanOfferMessage): Promise<void> {
    await this.broadcast({ v: 1, type: 'lan-ack', intentId: offer.intentId, from: this.selfId, to: WEB_PEER_ID });
    if (offer.direction === 'download') { await this.downloadFromBridge(offer); return; }
    const pending = this.pendingUploads.get(offer.intentId);
    if (!pending) {
      await this.complete(offer.intentId, false, 'LOCAL_BRIDGE_SOURCE_MISSING');
      return;
    }
    await this.uploadToBridge(offer, pending);
  }

  private async downloadFromBridge(offer: LanOfferMessage): Promise<void> {
    const target = new File(Paths.document, localFilename(offer.meta.name));
    try {
      const result = await FileSystem.downloadAsync(`${offer.endpoint}/v1/transfers/${offer.intentId}/download`, target.uri, {
        headers: { Authorization: `Bearer ${offer.token}` },
      });
      const info = await FileSystem.getInfoAsync(result.uri, { size: true });
      if (!info.exists || info.size !== offer.meta.size) throw new Error('LOCAL_BRIDGE_SIZE_MISMATCH');
      this.callbacks.onFileReceived?.({ uri: result.uri, name: offer.meta.name, mime: offer.meta.mime, size: offer.meta.size });
      await this.complete(offer.intentId, true);
    } catch (caught) {
      try { if (target.exists) target.delete(); } catch { /* remove only the temporary incomplete file */ }
      await this.complete(offer.intentId, false, caught instanceof Error ? caught.message.slice(0, 160) : 'LOCAL_BRIDGE_DOWNLOAD_FAILED');
    }
  }

  private async uploadToBridge(offer: LanOfferMessage, pending: PendingUpload): Promise<void> {
    try {
      const response = await FileSystem.uploadAsync(`${offer.endpoint}/v1/transfers/${offer.intentId}/upload`, pending.uri, {
        httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { Authorization: `Bearer ${offer.token}`, 'Content-Type': pending.meta.mime },
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`LOCAL_BRIDGE_UPLOAD_${response.status}`);
      clearTimeout(pending.timer); this.pendingUploads.delete(offer.intentId); pending.resolve();
      await this.complete(offer.intentId, true);
    } catch (caught) {
      clearTimeout(pending.timer); this.pendingUploads.delete(offer.intentId);
      pending.reject(caught instanceof Error ? caught : new Error('LOCAL_BRIDGE_UPLOAD_FAILED'));
      await this.complete(offer.intentId, false, caught instanceof Error ? caught.message.slice(0, 160) : 'LOCAL_BRIDGE_UPLOAD_FAILED');
    }
  }

  private async complete(intentId: string, success: boolean, error?: string): Promise<void> {
    try { await this.broadcast({ v: 1, type: 'lan-complete', intentId, from: this.selfId, to: WEB_PEER_ID, success, ...(error ? { error } : {}) }); }
    catch { /* sender will fall back to private Storage when it cannot observe completion */ }
  }
  private async broadcast(message: unknown): Promise<void> {
    if (!this.channel) throw new Error('LOCAL_BRIDGE_STOPPED');
    await this.channel.send({ type: 'broadcast', event: 'message', payload: message });
  }
}
