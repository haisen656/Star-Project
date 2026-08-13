import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import {
  LOCAL_BRIDGE_HANDSHAKE_TIMEOUT_MS,
  LOCAL_BRIDGE_PORT,
  WEB_PEER_ID,
  signalChannel,
  signalMessageSchema,
  type LanUploadRequestMessage,
} from '@quickdrop/shared';

type FileMeta = { name: string; size: number; mime: string };
type BridgeResponse = {
  transferId: string;
  endpoint: string;
  token: string;
  deviceToken: string;
  expiresAt: string;
  direction: 'browser-to-phone' | 'phone-to-browser';
};
type Deferred<T> = { resolve: (value: T) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export type LocalBridgeFile = FileMeta & { id: string; url: string };

export type LanBridgeCallbacks = {
  onIncomingFile?: (file: LocalBridgeFile) => void;
  onStatus?: (message: string) => void;
};

const LOCAL_URL = `http://127.0.0.1:${LOCAL_BRIDGE_PORT}`;
const COMPLETION_TIMEOUT_MS = 45 * 60 * 1000;

function messageError(payload: unknown): Error {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') return new Error(payload.error);
  return new Error('LOCAL_BRIDGE_REQUEST_FAILED');
}

function requestWithProgress(url: string, token: string, file: File, onProgress?: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100)); };
    xhr.onerror = () => reject(new Error('LOCAL_BRIDGE_NETWORK_ERROR'));
    xhr.onabort = () => reject(new Error('LOCAL_BRIDGE_ABORTED'));
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`LOCAL_BRIDGE_UPLOAD_${xhr.status}`));
    xhr.send(file);
  });
}

export class LanBridgeClient {
  private client: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private pendingAck = new Map<string, Deferred<void>>();
  private pendingComplete = new Map<string, Deferred<void>>();
  private incoming = new Map<string, { transfer: BridgeResponse; meta: FileMeta; from: string }>();

  constructor(private readonly spaceId: string, private readonly callbacks: LanBridgeCallbacks = {}) {}

  start(client: SupabaseClient): void {
    if (this.channel) return;
    this.client = client;
    this.channel = client.channel(signalChannel(this.spaceId), { config: { broadcast: { ack: true }, private: true } })
      .on('broadcast', { event: 'message' }, (message) => void this.onMessage(message.payload))
      .subscribe();
  }

  stop(): void {
    if (this.channel && this.client) void this.client.removeChannel(this.channel);
    this.channel = null; this.client = null;
    for (const pending of this.pendingAck.values()) { clearTimeout(pending.timer); pending.reject(new Error('LOCAL_BRIDGE_STOPPED')); }
    for (const pending of this.pendingComplete.values()) { clearTimeout(pending.timer); pending.reject(new Error('LOCAL_BRIDGE_STOPPED')); }
    this.pendingAck.clear(); this.pendingComplete.clear(); this.incoming.clear();
  }

  async sendFile(file: File, deviceId: string, onProgress?: (progress: number) => void): Promise<void> {
    const bridge = await this.getBridge(true);
    const meta: FileMeta = { name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream' };
    const transfer = await this.createTransfer(bridge.endpoint, 'browser-to-phone', meta);
    const ack = this.waitForAck(transfer.transferId);
    await this.broadcast({
      v: 1, type: 'lan-offer', intentId: transfer.transferId, from: WEB_PEER_ID, to: deviceId,
      direction: 'download', endpoint: transfer.endpoint, token: transfer.deviceToken, meta, expiresAt: transfer.expiresAt,
    });
    try {
      await ack;
      const complete = this.waitForCompletion(transfer.transferId);
      await requestWithProgress(`${transfer.endpoint}/v1/transfers/${transfer.transferId}/upload`, transfer.token, file, onProgress);
      await complete;
    } catch (caught) {
      await this.cancel(transfer.endpoint, transfer.transferId, transfer.token);
      throw caught;
    }
  }

  private async onMessage(payload: unknown): Promise<void> {
    const parsed = signalMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'lan-upload-request') { await this.onUploadRequest(message); return; }
    if (message.type === 'lan-ack' && message.to === WEB_PEER_ID) { this.resolve(this.pendingAck, message.intentId); return; }
    if (message.type === 'lan-complete' && message.to === WEB_PEER_ID) {
      const incoming = this.incoming.get(message.intentId);
      if (incoming) {
        this.incoming.delete(message.intentId);
        if (message.success) {
          const { transfer, meta } = incoming;
          this.callbacks.onIncomingFile?.({ id: transfer.transferId, ...meta, url: `${transfer.endpoint}/v1/transfers/${transfer.transferId}/download?token=${encodeURIComponent(transfer.token)}` });
        }
      }
      if (message.success) this.resolve(this.pendingComplete, message.intentId);
      else this.reject(this.pendingComplete, message.intentId, message.error ?? 'LOCAL_BRIDGE_TRANSFER_FAILED');
      return;
    }
    if (message.type === 'lan-cancel' && message.to === WEB_PEER_ID) {
      this.reject(this.pendingAck, message.intentId, 'LOCAL_BRIDGE_CANCELLED');
      this.reject(this.pendingComplete, message.intentId, 'LOCAL_BRIDGE_CANCELLED');
    }
  }

  private async onUploadRequest(message: LanUploadRequestMessage): Promise<void> {
    // This path runs in response to a background Realtime message. Browsers
    // cannot safely launch arbitrary local software without a user gesture,
    // so it only uses a bridge that was installed and started already.
    try {
      const bridge = await this.getBridge(false);
      const transfer = await this.createTransfer(bridge.endpoint, 'phone-to-browser', message.meta, message.intentId);
      this.incoming.set(transfer.transferId, { transfer, meta: message.meta, from: message.from });
      await this.broadcast({
        v: 1, type: 'lan-offer', intentId: transfer.transferId, from: WEB_PEER_ID, to: message.from,
        direction: 'upload', endpoint: transfer.endpoint, token: transfer.deviceToken, meta: message.meta, expiresAt: transfer.expiresAt,
      });
    } catch {
      // The phone owns the source bytes. If the helper is not ready it times
      // out quickly and uploads the same file to private Storage instead.
      await this.broadcast({ v: 1, type: 'lan-cancel', intentId: message.intentId, from: WEB_PEER_ID, to: message.from });
    }
  }

  private async getBridge(allowWake: boolean): Promise<{ endpoint: string }> {
    const healthy = async () => {
      const response = await fetch(`${LOCAL_URL}/health`, { cache: 'no-store' });
      if (!response.ok) throw new Error('LOCAL_BRIDGE_OFFLINE');
      const body = await response.json() as { endpoint?: string };
      if (!body.endpoint) throw new Error('LOCAL_BRIDGE_NO_LAN');
      return { endpoint: body.endpoint };
    };
    try { return await healthy(); }
    catch {
      if (!allowWake) throw new Error('LOCAL_BRIDGE_OFFLINE');
      // This is invoked only from the file-picker/drop user gesture. Windows
      // may show its normal external-protocol confirmation the first time.
      window.location.assign('quickdrop-bridge://start');
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        try { return await healthy(); } catch { /* keep polling while it starts */ }
      }
      throw new Error('LOCAL_BRIDGE_OFFLINE');
    }
  }

  private async createTransfer(endpoint: string, direction: BridgeResponse['direction'], meta: FileMeta, transferId?: string): Promise<BridgeResponse> {
    const response = await fetch(`${LOCAL_URL}/v1/transfers`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction, ...meta, ...(transferId ? { transferId } : {}) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw messageError(payload);
    const transfer = payload as BridgeResponse;
    if (transfer.endpoint !== endpoint || !transfer.transferId || !transfer.token || !transfer.deviceToken) throw new Error('LOCAL_BRIDGE_RESPONSE_INVALID');
    return transfer;
  }

  private waitForAck(id: string): Promise<void> { return this.wait(this.pendingAck, id, LOCAL_BRIDGE_HANDSHAKE_TIMEOUT_MS, 'LOCAL_BRIDGE_ACK_TIMEOUT'); }
  private waitForCompletion(id: string): Promise<void> { return this.wait(this.pendingComplete, id, COMPLETION_TIMEOUT_MS, 'LOCAL_BRIDGE_TRANSFER_TIMEOUT'); }
  private wait(map: Map<string, Deferred<void>>, id: string, timeout: number, reason: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { map.delete(id); reject(new Error(reason)); }, timeout);
      map.set(id, { resolve, reject, timer });
    });
  }
  private resolve(map: Map<string, Deferred<void>>, id: string): void { const pending = map.get(id); if (pending) { clearTimeout(pending.timer); map.delete(id); pending.resolve(); } }
  private reject(map: Map<string, Deferred<void>>, id: string, reason: string): void { const pending = map.get(id); if (pending) { clearTimeout(pending.timer); map.delete(id); pending.reject(new Error(reason)); } }
  private async cancel(endpoint: string, id: string, token: string): Promise<void> {
    try { await fetch(`${endpoint}/v1/transfers/${id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }); } catch { /* expiration removes temporary bridge state */ }
  }
  private async broadcast(message: unknown): Promise<void> { if (this.channel) await this.channel.send({ type: 'broadcast', event: 'message', payload: message }); }
}
