# QuickDrop 架构

## 身份与配对

网页和 App 首次运行都调用 `signInAnonymously()`。匿名 Supabase 用户是 RLS 的基础身份，不是用户可见的账号，也没有登录页、密码或邮箱流程。

网页调用 `create-transfer-space`。函数以服务端随机 UUID 创建空间，同时生成 4 位验证码、32 字节二维码 `pairing_token`。三个敏感值均遵循以下规则：验证码、二维码令牌、设备令牌只将带服务器 pepper 的 SHA-256 hash 写入数据库；明文验证码与二维码令牌仅返回给网页；设备令牌仅在配对成功的响应中返回一次。

二维码内容是 `{ "v": 1, "pairingToken": "…" }`，而不是可猜的 4 位码。手机用任一凭证调用 `pair-device`。数据库的 `claim_pairing_code` 函数在事务中锁定配对记录、检查空间、强制最多三台手机、写入设备关系并消费验证码。成功后 App 用 `expo-secure-store` 保存 256-bit `device_access_token` 和空间 ID。

## 数据流

```text
Web anonymous session ── create-transfer-space ──> space + one-time code/QR
Mobile anonymous session ── pair-device ─────────> paired_devices + device token
Web/App ── create-upload-url ──> signed private upload URL
Web/App ── complete-upload/create-text-item ────> transfer_items + Realtime
Web/App ── get-download-url ────────────────────> 60-second private download URL
```

文字、上传确认、删除、撤销和销毁均经过 Edge Function。客户端只对 `transfer_items` 订阅只读 Realtime。文件字节从不经公开 bucket 读取：上传使用一次性签名上传 URL，下载使用 60 秒签名 URL。

文件上传者或空间所有者可调用 `create-file-share-link`。该函数替换该文件先前的分享 token，并返回带 token 的 Web 下载页 URL；网页以二维码展示它。下载页或 `share-file-download` 函数验证带 hash 的 token、空间和文件状态后，才生成 60 秒私有 URL。手机 App 通过系统分享同一链接，两个客户端都支持按文件名或文本搜索已有传输项。

## 权限模型

`transfer_spaces`、`pairing_codes`、`paired_devices`、`transfer_items` 和 `rate_limit_events` 全部启用 RLS。默认没有客户端写策略。只读 `transfer_items` policy 只允许有效空间的所有者匿名用户或未撤销的已配对匿名用户。`paired_devices` 对所有者可见，对手机仅可见自身关系。

Edge Functions 验证请求里的匿名 JWT；若不是空间所有者，则还必须以 `x-device-access-token` 提交设备令牌。函数将其 hash 与 `paired_devices` 中的 hash 比对，并确认设备没有撤销、空间未过期。因此验证码从不作为后续访问凭证。

`quickdrop-files` 是 `public=false` bucket，刻意没有直接客户端 Storage policy。只有使用 `service_role` 的函数可创建签名 URL；`service_role` 只存在于 Supabase Edge Function 运行环境。

## 局域网直传

Web 与已配对手机同网时可通过 WebRTC DataChannel 直传文件与文本，信令经 Realtime 私有广播通道（RLS 鉴权），失败自动回退云端链路。直传 v1 仅处理不大于 64MB 的文件，以限制浏览器接收内存；更大文件仍使用私有 Storage（单文件、空间总量上限均为 2GB）。详见 [局域网直传设计方案](lan-p2p-transfer.md)。

## 生命周期

空间可在 1、24（默认）或 168 小时后到期；当前 Web 默认请求 24 小时。配对码固定十分钟，到期、配对成功、累计失败达到上限或重新生成后均失效。用户可销毁整个空间，所有文件与数据随之删除。定时函数删除全部过期空间、项及其私有 Storage 对象。
