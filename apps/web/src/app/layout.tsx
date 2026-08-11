import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'QuickDrop', description: '无需登录的临时跨设备传输' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
