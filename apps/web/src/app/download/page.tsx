'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '../../lib/supabase';

function DownloadResolver() {
  const params = useSearchParams();
  const [message, setMessage] = useState('正在安全获取下载链接…');

  useEffect(() => {
    const token = params.get('token');
    if (!token) { setMessage('下载链接无效。'); return; }
    async function resolve() {
      try {
        const { data, error } = await supabase().functions.invoke('share-file-download', { body: { token } });
        if (error || data?.error || !data?.url) throw new Error(data?.error?.message ?? '该分享链接无效、已过期或已撤销。');
        window.location.replace(data.url as string);
      } catch (caught) { setMessage(caught instanceof Error ? caught.message : '无法获取下载链接。'); }
    }
    void resolve();
  }, [params]);

  return <main className="grid min-h-screen place-items-center bg-emerald-50 p-6 text-center"><section className="max-w-md rounded-3xl border border-emerald-100 bg-white p-8 shadow-xl shadow-emerald-950/10"><p className="text-sm font-bold text-emerald-700">QuickDrop 安全下载</p><h1 className="mt-3 text-2xl font-bold text-slate-800">{message}</h1><p className="mt-3 text-sm text-slate-500">下载链接仅在验证通过后短暂有效。</p></section></main>;
}

export default function DownloadPage() {
  return <Suspense fallback={<main className="grid min-h-screen place-items-center bg-emerald-50 text-slate-600">正在加载…</main>}><DownloadResolver /></Suspense>;
}
