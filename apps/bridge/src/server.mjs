import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const PORT = Number(process.env.QUICKDROP_BRIDGE_PORT ?? 47561);
const TRANSFER_TTL_MS = 10 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 180;
const STORAGE_DIR = join(tmpdir(), 'quickdrop-bridge');
const DEFAULT_ORIGINS = ['https://star-project-1.vercel.app', 'http://localhost:3000', 'http://127.0.0.1:3000'];
const allowedOrigins = new Set((process.env.QUICKDROP_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS.join(','))
  .split(',').map((value) => value.trim()).filter(Boolean));
const transfers = new Map();

mkdirSync(STORAGE_DIR, { recursive: true });

function isPrivateIPv4(address) {
  const numbers = address.split('.').map(Number);
  if (numbers.length !== 4 || numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return numbers[0] === 10 || (numbers[0] === 192 && numbers[1] === 168)
    || (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31);
}

function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) return entry.address;
    }
  }
  return null;
}

function token() { return randomBytes(32).toString('base64url'); }
function hash(value) { return createHash('sha256').update(value).digest(); }
function matchesToken(value, expectedHash) {
  if (!value || !expectedHash) return false;
  const actual = hash(value);
  return actual.length === expectedHash.length && timingSafeEqual(actual, expectedHash);
}
function safeFilename(value) {
  const base = String(value ?? '').split(/[\\/]+/).pop().replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return (base || 'file').slice(0, MAX_FILENAME_LENGTH);
}
function dangerous(value) { return /\.(?:ade|adp|app|bat|cmd|com|cpl|dll|exe|hta|inf|ins|isp|jar|jse|lib|lnk|msc|msi|msp|mst|pif|ps1|reg|scr|sct|sh|sys|vb|vbe|vbs|wsc|wsf|wsh)$/i.test(value); }
function dangerousMime(value) { return /(?:x-msdownload|x-dosexec|x-sh|x-bat|portable-executable)/i.test(value); }
function isAllowedOrigin(request) { const origin = request.headers.origin; return Boolean(origin && allowedOrigins.has(origin)); }
function setCors(request, response) {
  if (!isAllowedOrigin(request)) return;
  response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-quickdrop-bridge-request');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
}
function json(request, response, status, body) {
  setCors(request, response);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
function bearer(request) {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
}
async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 8 * 1024) throw new Error('BODY_TOO_LARGE');
  }
  return JSON.parse(raw);
}
function getTransfer(id) {
  const transfer = transfers.get(id);
  if (!transfer || transfer.expiresAt <= Date.now()) {
    if (transfer) discard(transfer);
    return null;
  }
  return transfer;
}
function discard(transfer) {
  clearTimeout(transfer.timer);
  if (transfer.filePath && existsSync(transfer.filePath)) rmSync(transfer.filePath, { force: true });
  try { transfer.pendingDownload?.destroy(); } catch { /* best effort */ }
  try { transfer.pendingUpload?.destroy(); } catch { /* best effort */ }
  transfers.delete(transfer.id);
}
function publicTransfer(transfer, browserToken) {
  const ip = lanAddress();
  if (!ip) throw new Error('LAN_ADDRESS_UNAVAILABLE');
  return {
    transferId: transfer.id,
    endpoint: `http://${ip}:${PORT}`,
    token: browserToken,
    expiresAt: new Date(transfer.expiresAt).toISOString(),
  };
}
function sendDownloadResponse(transfer, response) {
  response.writeHead(200, {
    'content-type': transfer.meta.mime,
    'content-length': String(transfer.meta.size),
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(transfer.meta.name)}`,
    'cache-control': 'no-store',
  });
}
function beginBrowserToPhone(transfer) {
  if (!transfer.pendingUpload || !transfer.pendingDownload || transfer.piping) return;
  transfer.piping = true;
  sendDownloadResponse(transfer, transfer.pendingDownload);
  void pipeline(transfer.pendingUpload, transfer.pendingDownload)
    .then(() => { transfer.completed = true; discard(transfer); })
    .catch(() => discard(transfer));
}
function validateMeta(body) {
  const name = safeFilename(body?.name);
  const size = body?.size;
  const mime = String(body?.mime ?? '').slice(0, 160).toLowerCase();
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES || !mime || dangerous(name) || dangerousMime(mime)) throw new Error('INVALID_FILE_METADATA');
  return { name, size, mime };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(request)) return json(request, response, 403, { error: 'ORIGIN_DENIED' });
      setCors(request, response); response.writeHead(204); response.end(); return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      const endpoint = lanAddress();
      return json(request, response, endpoint ? 200 : 503, { ok: Boolean(endpoint), endpoint: endpoint ? `http://${endpoint}:${PORT}` : null, version: 1 });
    }
    if (request.method === 'POST' && url.pathname === '/v1/transfers') {
      if (!isAllowedOrigin(request)) return json(request, response, 403, { error: 'ORIGIN_DENIED' });
      const body = await readJson(request);
      const direction = body?.direction;
      if (direction !== 'browser-to-phone' && direction !== 'phone-to-browser') return json(request, response, 400, { error: 'INVALID_DIRECTION' });
      const meta = validateMeta(body);
      const requestedId = typeof body?.transferId === 'string' ? body.transferId : '';
      const id = requestedId || randomUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || transfers.has(id)) {
        return json(request, response, 400, { error: 'INVALID_TRANSFER_ID' });
      }
      const uploadToken = token(); const downloadToken = token();
      const transfer = {
        id, direction, meta, expiresAt: Date.now() + TRANSFER_TTL_MS,
        uploadTokenHash: hash(uploadToken), downloadTokenHash: hash(downloadToken),
        filePath: direction === 'phone-to-browser' ? join(STORAGE_DIR, `${id}.part`) : null,
        pendingUpload: null, pendingDownload: null, piping: false, completed: false, uploadedBytes: 0,
      };
      transfer.timer = setTimeout(() => discard(transfer), TRANSFER_TTL_MS);
      transfers.set(id, transfer);
      const browserToken = direction === 'browser-to-phone' ? uploadToken : downloadToken;
      const deviceToken = direction === 'browser-to-phone' ? downloadToken : uploadToken;
      return json(request, response, 201, { ...publicTransfer(transfer, browserToken), deviceToken, direction });
    }

    const route = /^\/v1\/transfers\/([0-9a-f-]{36})\/(upload|download|cancel)$/i.exec(url.pathname);
    if (!route) return json(request, response, 404, { error: 'NOT_FOUND' });
    const [, id, action] = route;
    const transfer = getTransfer(id);
    if (!transfer) return json(request, response, 404, { error: 'TRANSFER_EXPIRED' });
    const supplied = bearer(request) || url.searchParams.get('token') || '';
    const isUpload = matchesToken(supplied, transfer.uploadTokenHash);
    const isDownload = matchesToken(supplied, transfer.downloadTokenHash);
    if (!isUpload && !isDownload) return json(request, response, 401, { error: 'TOKEN_INVALID' });
    if (action === 'cancel' && request.method === 'POST') { discard(transfer); return json(request, response, 204, {}); }

    if (action === 'upload' && request.method === 'PUT' && isUpload) {
      if (transfer.pendingUpload || transfer.completed) return json(request, response, 409, { error: 'UPLOAD_ALREADY_USED' });
      const declared = Number(request.headers['content-length'] ?? transfer.meta.size);
      if (!Number.isFinite(declared) || declared !== transfer.meta.size) return json(request, response, 400, { error: 'SIZE_MISMATCH' });
      if (transfer.direction === 'browser-to-phone') {
        transfer.pendingUpload = request;
        request.on('aborted', () => discard(transfer));
        beginBrowserToPhone(transfer);
        request.once('end', () => { if (!response.writableEnded) json(request, response, 201, { ok: true }); });
        return;
      }
      let bytes = 0;
      request.on('data', (chunk) => { bytes += chunk.length; if (bytes > transfer.meta.size) request.destroy(new Error('SIZE_LIMIT')); });
      await pipeline(request, createWriteStream(transfer.filePath, { flags: 'wx' }));
      if (bytes !== transfer.meta.size) { discard(transfer); return json(request, response, 400, { error: 'SIZE_MISMATCH' }); }
      transfer.uploadedBytes = bytes; transfer.completed = true;
      return json(request, response, 201, { ok: true });
    }

    if (action === 'download' && request.method === 'GET' && isDownload) {
      if (transfer.direction === 'browser-to-phone') {
        if (transfer.pendingDownload || transfer.completed) return json(request, response, 409, { error: 'DOWNLOAD_ALREADY_USED' });
        transfer.pendingDownload = response;
        request.on('aborted', () => discard(transfer));
        beginBrowserToPhone(transfer);
        return;
      }
      if (!transfer.completed || !transfer.filePath || !existsSync(transfer.filePath)) return json(request, response, 409, { error: 'UPLOAD_NOT_COMPLETE' });
      sendDownloadResponse(transfer, response);
      createReadStream(transfer.filePath).pipe(response).once('close', () => discard(transfer));
      return;
    }
    return json(request, response, 405, { error: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'BRIDGE_ERROR';
    return json(request, response, code === 'LAN_ADDRESS_UNAVAILABLE' ? 503 : 400, { error: code });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // Do not log tokens, filenames, or client addresses. This process is meant
  // to be a quiet background helper; health is exposed only to the local page.
  process.stdout.write(`QuickDrop Bridge listening on ${PORT}\n`);
});

function shutdown() {
  for (const transfer of [...transfers.values()]) discard(transfer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
