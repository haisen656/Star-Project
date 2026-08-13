# 发布 Web URL 与 Android APK

QuickDrop 的文件分享链接依赖公开 HTTPS Web 地址。先完成 Supabase，再部署 Web，最后构建 APK；不要在客户端配置 `SUPABASE_SERVICE_ROLE_KEY`、`PAIRING_HASH_SECRET` 或 `CRON_SECRET`。

## 1. Supabase

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase secrets set PAIRING_HASH_SECRET="至少 32 字符的随机值" CRON_SECRET="另一随机值" WEB_APP_URL="https://YOUR_WEB_DOMAIN"
supabase functions deploy create-transfer-space pair-device get-download-url revoke-device cleanup-expired-spaces regenerate-pairing-code create-upload-url complete-upload create-text-item get-space-state delete-transfer-item destroy-transfer-space create-file-share-link share-file-download
```

将 `cleanup-expired-spaces` 设为每小时由可信调度器调用一次，并携带 `x-cron-secret`。保存以下公开值供 Web 与 App 使用：项目 URL、anon key。

## 2. Web URL（Vercel）

在 Vercel 导入仓库，设置 Root Directory 为 `apps/web`。首次部署前确认 Vercel 能访问整个 monorepo（`@quickdrop/shared` 使用 pnpm workspace）。配置：

```text
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
NEXT_PUBLIC_APP_URL=https://YOUR_WEB_DOMAIN
```

部署完成后得到的 `https://YOUR_WEB_DOMAIN` 就是最终网页地址。把相同地址设置为 Supabase 的 `WEB_APP_URL` secret 后，再部署一次 `create-file-share-link`，以确保二维码链接指向此域名。

## 3. APK（Expo EAS）

在 `apps/mobile` 设置 EAS 的公开环境变量：

```text
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

然后登录 Expo 并构建可安装 APK：

```bash
npx eas-cli@latest login
pnpm --filter @quickdrop/mobile build:apk
```

EAS 完成后输出的 artifact URL 是最终 APK 下载地址。生产商店发布使用 `production` profile，它输出 Android App Bundle；`apk` profile 专用于直接下载安装。

## 分享链接安全

网页的“二维码 / 链接”会生成 32-byte 随机分享令牌。令牌仅存 hash，默认 1 小时后失效（不晚于空间到期）；生成新链接会撤销旧链接。扫描链接后，`share-file-download` 验证令牌、文件和空间状态，再签发 60 秒私有 Storage URL。
