# QuickDrop

QuickDrop 是一个无账号、短生命周期的跨设备文件与文本传输工具。电脑网页自动创建匿名传输空间，手机通过一次性验证码或二维码配对；配对后由匿名身份加设备访问令牌共同授权。

## 项目结构

```text
apps/web                 Next.js 响应式传输面板
apps/mobile              Expo iOS/Android App
packages/shared          配对、限流、访问、文件校验的共享规则与测试
supabase/migrations      数据表、索引、RLS、私有 Storage bucket
supabase/functions       Edge Functions
docs                     架构和安全说明
```

## 本地启动

1. 安装 Node.js 20+、pnpm 11+、Supabase CLI 和 Expo 工具链。
2. 在仓库根目录运行 `pnpm install`。
3. 复制 `.env.example` 的公开变量：Web 放入 `apps/web/.env.local`，Expo 使用 `EXPO_PUBLIC_*` 环境变量。
4. 创建 Supabase 项目后执行：

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase secrets set PAIRING_HASH_SECRET="至少 32 字符的随机服务端密钥" CRON_SECRET="随机 cron 密钥"
supabase functions deploy create-transfer-space pair-device get-download-url revoke-device cleanup-expired-spaces regenerate-pairing-code create-upload-url complete-upload create-text-item get-space-state delete-transfer-item destroy-transfer-space create-file-share-link share-file-download create-p2p-item
```

5. 启动客户端：

```bash
pnpm --filter @quickdrop/web dev
pnpm --filter @quickdrop/mobile start
```

访问 Web 后无需任何注册或登录操作；它会静默创建 Supabase Anonymous Auth 会话和一个 24 小时空间。

## 验证

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 运维：清理任务

每小时调用一次 `cleanup-expired-spaces`，并在请求中携带 `x-cron-secret: $CRON_SECRET`。该函数删除过期空间的 Storage 对象及关联数据库行，并删除过期的限流事件。可使用 Supabase Cron + `pg_net`、受保护的 CI cron 或任意可信调度器；不要把 `CRON_SECRET` 暴露给客户端。

每个文件可生成一个可撤销的安全分享链接；Web 会以二维码展示，手机可通过系统分享链接。链接令牌默认一小时失效，扫码后的实际私有下载 URL 仍只有效 60 秒。

详见 [架构说明](docs/architecture.md)、[安全说明](docs/security.md) 与 [发布 Web URL / APK](docs/deployment.md)。局域网直传（WebRTC P2P）方案见 [设计文档](docs/lan-p2p-transfer.md)。
