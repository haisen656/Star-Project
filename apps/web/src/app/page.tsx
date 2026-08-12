'use client';

import { QRCodeSVG } from 'qrcode.react';
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';

type Space = { id: string; expires_at: string; name: string };
type Pairing = { code: string; pairingToken: string; pairingExpiresAt: string; qrPayload: string };
type Item = { id: string; type: 'file' | 'text'; title: string; text_content: string | null; original_filename: string | null; mime_type: string | null; file_size: number | null; created_at: string };
type Device = { id: string; device_name: string; device_type: string; paired_at: string; last_seen_at: string };
type Upload = { name: string; progress: number; error?: string };
type FileShare = { shareUrl: string; directDownloadUrl: string; expiresAt: string; title: string };

const byteLabel = (size: number | null) => !size ? '' : size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`;
const timeLabel = (iso: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));

function uploadWithProgress(url: string, file: File, progress: (value: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // Browser-side Supabase signed uploads use multipart form data. A raw File
    // request is rejected by the Storage endpoint with HTTP 400.
    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', file);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100)); };
    xhr.onerror = () => reject(new Error('文件上传网络错误。'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
      let detail = '';
      try {
        const response = JSON.parse(xhr.responseText) as { message?: string; error?: string };
        detail = response.message ?? response.error ?? '';
      } catch { /* Use the HTTP status fallback below. */ }
      reject(new Error(detail || `上传失败（${xhr.status}）`));
    };
    xhr.send(form);
  });
}

export default function TransferPanel() {
  const [space, setSpace] = useState<Space>();
  const [pairing, setPairing] = useState<Pairing>();
  const [items, setItems] = useState<Item[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [clipboardText, setClipboardText] = useState('');
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [fileShare, setFileShare] = useState<FileShare>();
  const [seconds, setSeconds] = useState(0);
  const [bootError, setBootError] = useState('');

  const invoke = useCallback(async <T,>(name: string, body: Record<string, unknown>): Promise<T> => {
    const { data, error } = await supabase().functions.invoke(name, { body });
    if (error) throw error;
    if (data?.error) throw new Error(data.error.message);
    return data as T;
  }, []);

  const refresh = useCallback(async (spaceId: string) => {
    const [itemsResult, state] = await Promise.all([
      supabase().from('transfer_items').select('id,type,title,text_content,original_filename,mime_type,file_size,created_at').eq('transfer_space_id', spaceId).order('created_at', { ascending: false }),
      invoke<{ space: Space; devices: Device[] }>('get-space-state', { transferSpaceId: spaceId }),
    ]);
    if (itemsResult.error) throw itemsResult.error;
    setItems((itemsResult.data ?? []) as Item[]); setDevices(state.devices ?? []); setSpace(state.space);
  }, [invoke]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        const client = supabase();
        const { data: sessionData } = await client.auth.getSession();
        if (!sessionData.session) { const { error } = await client.auth.signInAnonymously(); if (error) throw error; }
        const created = await invoke<{ transferSpaceId: string; code: string; pairingToken: string; pairingExpiresAt: string; expiresAt: string; qrPayload: string }>('create-transfer-space', { expiresInHours: 24 });
        if (cancelled) return;
        setSpace({ id: created.transferSpaceId, expires_at: created.expiresAt, name: '临时传输空间' });
        setPairing(created); await refresh(created.transferSpaceId);
      } catch (caught) { if (!cancelled) setBootError(caught instanceof Error ? caught.message : '无法建立临时传输空间。'); }
    }
    void start(); return () => { cancelled = true; };
  }, [invoke, refresh]);

  useEffect(() => {
    if (!space) return;
    const channel = supabase().channel(`quickdrop-${space.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transfer_items', filter: `transfer_space_id=eq.${space.id}` }, () => void refresh(space.id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'paired_devices', filter: `transfer_space_id=eq.${space.id}` }, () => void refresh(space.id))
      .subscribe();
    return () => { void supabase().removeChannel(channel); };
  }, [refresh, space]);

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(pairing ? Math.max(0, Math.ceil((new Date(pairing.pairingExpiresAt).getTime() - Date.now()) / 1000)) : 0), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const regenerate = async () => {
    if (!space) return;
    try { setPairing(await invoke<Pairing>('regenerate-pairing-code', { transferSpaceId: space.id })); setNotice('已生成新的单次配对验证码。'); }
    catch (caught) { setNotice(caught instanceof Error ? caught.message : '生成失败。'); }
  };

  const addFiles = async (fileList: FileList | File[]) => {
    if (!space) return;
    for (const file of Array.from(fileList)) {
      const key = `${file.name}-${file.lastModified}`; setUploads((current) => [...current, { name: file.name, progress: 0 }]);
      try {
        const ticket = await invoke<{ storagePath: string; signedUrl: string; filename: string }>('create-upload-url', { transferSpaceId: space.id, filename: file.name, mimeType: file.type || 'application/octet-stream', size: file.size });
        await uploadWithProgress(ticket.signedUrl, file, (progress) => setUploads((current) => current.map((upload) => upload.name === file.name ? { ...upload, progress } : upload)));
        await invoke('complete-upload', { transferSpaceId: space.id, storagePath: ticket.storagePath, filename: ticket.filename, mimeType: file.type || 'application/octet-stream', size: file.size });
        setUploads((current) => current.map((upload) => upload.name === file.name ? { ...upload, progress: 100 } : upload));
      } catch (caught) { setUploads((current) => current.map((upload) => upload.name === file.name ? { ...upload, error: caught instanceof Error ? caught.message : '上传失败' } : upload)); }
      void key;
    }
  };

  const readClipboard = async () => {
    try { setClipboardText(await navigator.clipboard.readText()); setNotice('已读取剪贴板文字，请确认后同步。'); }
    catch { setNotice('浏览器未授予剪贴板权限，请在下方手动粘贴。'); }
  };
  const sendText = async () => {
    if (!space || !clipboardText.trim()) return;
    try { await invoke('create-text-item', { transferSpaceId: space.id, text: clipboardText }); setClipboardText(''); setNotice('文字已同步。'); }
    catch (caught) { setNotice(caught instanceof Error ? caught.message : '同步失败。'); }
  };
  const download = async (item: Item) => {
    if (!space) return;
    try { const data = await invoke<{ url: string }>('get-download-url', { transferSpaceId: space.id, transferItemId: item.id }); window.open(data.url, '_blank', 'noopener,noreferrer'); }
    catch (caught) { setNotice(caught instanceof Error ? caught.message : '下载失败。'); }
  };
  const createShare = async (item: Item) => {
    if (!space) return;
    try {
      const data = await invoke<Omit<FileShare, 'title'>>('create-file-share-link', { transferSpaceId: space.id, transferItemId: item.id });
      setFileShare({ ...data, title: item.title });
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : '无法创建分享链接。'); }
  };
  const removeItem = async (id: string) => { if (space && window.confirm('确定删除该传输项？')) { await invoke('delete-transfer-item', { transferSpaceId: space.id, transferItemId: id }); } };
  const removeDevice = async (id: string) => { if (space && window.confirm('移除此手机后，它将立即失去访问权限。')) { await invoke('revoke-device', { transferSpaceId: space.id, deviceId: id }); await refresh(space.id); } };
  const destroy = async () => { if (space && window.confirm('立即销毁空间会删除所有文件和文本，且无法恢复。')) { await invoke('destroy-transfer-space', { transferSpaceId: space.id }); setSpace(undefined); setNotice('传输空间已销毁。刷新页面可创建新的空间。'); } };
  const onFiles = (event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ''; };
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); void addFiles(event.dataTransfer.files); };
  const countdown = useMemo(() => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`, [seconds]);
  const visibleItems = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return query ? items.filter((item) => `${item.title}\n${item.text_content ?? ''}`.toLocaleLowerCase().includes(query)) : items;
  }, [items, searchQuery]);

  if (bootError) return <main className="mx-auto max-w-xl p-6"><section className="panel p-6"><h1 className="text-2xl font-bold">QuickDrop</h1><p className="mt-4 text-rose-200">{bootError}</p><button className="action mt-5" onClick={() => window.location.reload()}>重新尝试</button></section></main>;
  if (!space || !pairing) return <main className="grid min-h-screen place-items-center"><p className="text-slate-300">正在建立加密的临时传输空间…</p></main>;

  return <main className="mx-auto max-w-6xl p-4 md:p-8">
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm text-emerald-300">匿名临时传输 · 无需账号</p><h1 className="text-3xl font-bold">QuickDrop</h1></div><p className="text-sm text-slate-300">空间将在 {timeLabel(space.expires_at)} 自动清理</p></header>
    {notice && <p className="mb-4 rounded-lg border border-sky-800 bg-sky-950/50 p-3 text-sm text-sky-100">{notice}</p>}
    <div className="grid gap-5 lg:grid-cols-[370px_1fr]">
      <section className="panel p-5"><p className="text-sm text-slate-300">用手机 QuickDrop App 扫码或输入验证码</p><div className="my-4 grid place-items-center rounded-xl bg-white p-4"><QRCodeSVG value={pairing.qrPayload} size={190} level="M" /></div><div className="rounded-xl bg-slate-950 p-4 text-center"><p className="text-4xl font-black tracking-[.35em] text-emerald-300">{pairing.code}</p><p className="mt-2 text-sm text-slate-400">验证码剩余 {countdown} · 仅成功使用一次</p></div><button className="secondary mt-4 w-full" onClick={() => void regenerate()}>重新生成验证码</button><div className="mt-6 border-t border-slate-700 pt-4"><p className="font-semibold">已连接设备 ({devices.length}/3)</p>{devices.length === 0 ? <p className="mt-2 text-sm text-slate-400">暂无已配对手机</p> : devices.map((device) => <div className="mt-3 flex items-center justify-between text-sm" key={device.id}><span>{device.device_name} · {device.device_type}</span><button className="secondary danger text-xs" onClick={() => void removeDevice(device.id)}>移除</button></div>)}</div></section>
      <section className="space-y-5"><div className="panel p-5" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><h2 className="font-bold">发送文件</h2><p className="mt-1 text-sm text-slate-400">拖入或选择文件。单文件和空间总容量均最多 2GB，危险可执行类型会被阻止。</p><label className="action mt-4 inline-block"><input className="hidden" type="file" multiple onChange={onFiles} />选择文件</label>{uploads.map((upload, index) => <div className="mt-3 text-sm" key={`${upload.name}-${index}`}><div className="flex justify-between"><span>{upload.name}</span><span>{upload.error ?? `${upload.progress}%`}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-700"><div className="h-full bg-emerald-400" style={{ width: `${upload.progress}%` }} /></div></div>)}</div>
      <div className="panel p-5"><h2 className="font-bold">同步文字</h2><div className="mt-3 flex flex-wrap gap-2"><button className="action" onClick={() => void readClipboard()}>读取并同步剪贴板文字</button><button className="secondary" onClick={() => void sendText()} disabled={!clipboardText.trim()}>发送文字</button></div><textarea className="mt-3 min-h-28 w-full rounded-xl border border-slate-600 bg-slate-950 p-3" value={clipboardText} onChange={(event) => setClipboardText(event.target.value)} placeholder="剪贴板权限被拒绝时，可在此手动粘贴文字" /></div>
      <div className="panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-bold">实时传输列表</h2><div className="flex gap-2"><input className="search-input" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索文件或文字" /><button className="secondary text-sm" onClick={() => void refresh(space.id)}>刷新</button></div></div>{visibleItems.length === 0 ? <p className="mt-4 text-sm text-slate-400">{searchQuery ? '没有匹配的传输内容。' : '还没有传输内容。'}</p> : <div className="mt-3 divide-y divide-slate-700">{visibleItems.map((item) => <article className="py-3" key={item.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">{item.type === 'file' ? '文件 · ' : '文本 · '}{item.title}</p><p className="mt-1 text-xs text-slate-400">{timeLabel(item.created_at)} {item.file_size ? `· ${byteLabel(item.file_size)}` : ''}</p>{item.type === 'text' && <p className="mt-2 max-w-xl whitespace-pre-wrap text-sm text-slate-300">{item.text_content}</p>}</div><div className="flex flex-wrap gap-2">{item.type === 'file' ? <><button className="secondary text-sm" onClick={() => void download(item)}>下载</button><button className="secondary text-sm" onClick={() => void createShare(item)}>二维码 / 链接</button></> : <button className="secondary text-sm" onClick={() => void navigator.clipboard.writeText(item.text_content ?? '')}>复制</button>}<button className="secondary danger text-sm" onClick={() => void removeItem(item.id)}>删除</button></div></div></article>)}</div>}</div>
      <button className="secondary danger w-full" onClick={() => void destroy()}>立即销毁此传输空间</button></section>
    </div>
    {fileShare && <div className="fixed inset-0 z-20 grid place-items-center bg-slate-900/25 p-4"><section className="share-dialog"><button className="float-right text-slate-500" onClick={() => setFileShare(undefined)}>关闭</button><p className="text-sm font-bold text-emerald-700">安全文件分享</p><h2 className="mt-2 text-xl font-bold">{fileShare.title}</h2><div className="my-5 grid place-items-center rounded-2xl bg-white p-4"><QRCodeSVG value={fileShare.shareUrl} size={210} level="M" /></div><p className="text-sm text-slate-600">扫描二维码即可直接下载。链接将在 {timeLabel(fileShare.expiresAt)} 失效。</p><input className="share-link" readOnly value={fileShare.shareUrl} onFocus={(event) => event.currentTarget.select()} /><div className="mt-3 flex gap-2"><button className="action" onClick={() => void navigator.clipboard.writeText(fileShare.shareUrl).then(() => setNotice('分享链接已复制。'))}>复制链接</button><a className="secondary text-center" href={fileShare.shareUrl} target="_blank" rel="noreferrer">测试下载页</a></div></section></div>}
  </main>;
}
