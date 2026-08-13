# QuickDrop 局域网直传（WebRTC P2P）设计方案

状态：实施中。

## 1. 目标与范围

当 Web 端与已配对的手机处于同一局域网（通常为同一 Wi-Fi）时，文件与文本通过 WebRTC DataChannel 直接在两端间传输，不经过 Supabase Storage，避免公网往返；当无法建立直连（异网、NAT 或超时）时，自动静默回退到现有云端链路。UI 始终标识当前传输模式。

范围与取舍：

- v1 仅支持 **Web ↔ 手机** 一对一传输；手机 ↔ 手机直传不在本期范围（两手机都只与空间交互，直传收益小）。
- 直传内容**即时送达**：文件字节不写入云端 Storage；文本经 DataChannel 送达后由发送方落一条元数据记录。为保持两端列表语义一致，直传成功后仍通过新 Edge Function 记录一条 `transport='p2p'` 的传输项（见 §5），该项仅作"送达回执"，不可再次下载/分享。
- 直传 v1 的文件上限为 **64MB**。这是浏览器接收端在保存前需要保留内存副本的安全界限；大于 64MB 的文件、异网连接或任何直传异常均自动回退到私有 Supabase Storage，云端单文件与空间上限仍为 2GB。
- 不做 STUN/TURN。同网场景 host candidate（含 mDNS）足以建连；异网建连失败即回退，不需要 TURN 的兜底成本。
- 直传要求两端 App/页面处于前台（见 §9 风险）。

## 2. 总体架构

```text
┌──────────────┐   SDP/ICE/心跳（广播，RLS 鉴权）   ┌──────────────┐
│  Web (owner) │ ◄──────── Supabase Realtime ───────► │ Mobile (设备) │
└──────┬───────┘   topic: qd-signal-<spaceId>        └──────┬───────┘
       │                                                    │
       │        WebRTC DataChannel（同网直连，DTLS 加密）      │
       └──────────────────────────────►──────────────────────┘
                        失败/超时 → 回退现有云链路
```

- **信令**：Supabase Realtime 私有广播通道 `qd-signal-<spaceId>`（supabase-js 通道名只允许 `[a-zA-Z0-9_-]`，故分隔符用 `-` 而非 `:`），RLS 限制仅空间 owner 与未撤销配对设备可收发（§4）。信令消息只有 SDP/ICE/心跳/意图等小控制帧，**文件与文本字节一律走 DataChannel，不进广播**。
- **鉴权模型不变**：Realtime 的 WebSocket 无法携带 `x-device-access-token` 自定义头，因此信令鉴权以匿名 JWT 为身份、通过 `paired_devices` 成员关系判定（等价于设备令牌的 RLS 形态）；所有写路径（记录回执、云端链路）仍由 Edge Function + 设备令牌校验。
- **数据面**：`RTCPeerConnection` + 单个可靠有序 DataChannel，64KB 分块，带 SHA-256 完整性校验与双端进度。

## 3. 信令协议（packages/shared/src/signaling.ts）

通道名：`qd-signal-<spaceId>`。客户端用私有通道订阅：

```ts
supabase().channel(`qd-signal-${spaceId}`, {
  config: { broadcast: { ack: true }, private: true },
})
```

私有通道的 access token 由 supabase-js ≥2.38 自动换取，无需自定义逻辑。

消息统一为 JSON，携带 `v: 1`：

| type | 方向 | 内容 | 说明 |
|---|---|---|---|
| `hello` | 全端 | `{ from }` | 心跳，前台每 10s 一条；用于在线探测与对端列表 |
| `intent` | sender→receiver | `{ intentId, from, to, kind, meta }` | 传输意图：`kind:'file'` 带 `{name,size,mime}`；`kind:'text'` 带 `{length}` |
| `intent-ack` | receiver→sender | `{ intentId, from, to }` | 接受，随后等待 offer |
| `intent-nack` | receiver→sender | `{ intentId, from, to, reason }` | 拒绝（忙/离线）→ 触发云回退 |
| `sdp` | 双向 | `{ intentId, from, to, sdp: {type,sdp} }` | offer/answer；sender 为 ICE initiator |
| `ice` | 双向 | `{ intentId, from, to, candidate }` | ICE candidate |
| `cancel` | 双向 | `{ intentId, from, to }` | 放弃本次直传 |
| `bye` | 双向 | `{ from }` | 拆线 |

对端标识：Web 固定为 `web`；手机用配对返回的 `deviceId`（`paired_devices.id`，`pair-device` 已返回该字段）。

常量（进 shared，两端与文档一致）：

```ts
P2P_PROTOCOL_VERSION = 1
HEARTBEAT_INTERVAL_MS = 10_000
PEER_STALE_MS          = 22_000
P2P_CONNECT_TIMEOUT_MS = 8_000
P2P_STALL_TIMEOUT_MS   = 30_000
P2P_CHUNK_BYTES        = 64 * 1024
MAX_DIRECT_FILE_BYTES  = 64 * 1024 * 1024
```

DataChannel 帧协议（同通道，字符串帧为控制 JSON，二进制帧为数据分块）：

```ts
{ t: 'header', transferId, name, size, mime, chunkSize, sha256 }  // 文件首帧
{ t: 'text',   transferId, text }                                 // 文本整帧（≤100k 字符）
{ t: 'done',   transferId, received }                             // 接收端校验通过
{ t: 'error',  transferId, reason }                               // 校验失败/中断
// 二进制帧：定长 64KB，末帧按剩余字节截断（接收端以 size 判定结束）
```

## 4. 数据库迁移（supabase/migrations/202608130001_lan_p2p.sql）

### 4.1 信令通道 RLS（Realtime Broadcast Authorization）

广播鉴权通过 `realtime.messages` 上的 RLS 策略实现（INSERT=发送、SELECT=接收，官方支持迁移内建策略）。策略必须对 `topic` 做防御性解析，兼容 topic 是否带 `realtime:` 前缀：

```sql
create or replace function public.is_space_member(space_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_space_owner(space_id) or public.is_active_paired_device(space_id);
$$;

create or replace function public.signal_topic_space(topic text)
returns uuid language sql immutable security definer set search_path = public as $$
  select case
    when topic ~* '^(:?realtime:)?qd-signal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (substring(topic from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))::uuid
    else null::uuid
  end;
$$;

create policy "space members send signaling" on realtime.messages for insert to authenticated
  with check (public.is_space_member(public.signal_topic_space(topic)));
create policy "space members receive signaling" on realtime.messages for select to authenticated
  using (public.is_space_member(public.signal_topic_space(topic)));
```

撤销设备、空间过期后 `is_space_member` 立即为假，信令随之失效。

### 4.2 直传回执：transfer_items.transport

```sql
alter table public.transfer_items
  add column transport text not null default 'cloud'
  check (transport in ('cloud', 'p2p'));

-- 原迁移的无名 check 约束按内容定位后重建（约束名不可移植）
do $$ declare cname text; begin
  select conname into cname from pg_constraint
  where conrelid = 'public.transfer_items'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%text_content%';
  if cname is not null then
    execute format('alter table public.transfer_items drop constraint %I', cname);
  end if;
end $$;

alter table public.transfer_items add constraint transfer_items_type_check check (
  (type = 'text' and text_content is not null and storage_path is null and file_size is null)
  or (type = 'file' and text_content is null and original_filename is not null
      and mime_type is not null and file_size > 0
      and ((transport = 'cloud' and storage_path is not null)
        or (transport = 'p2p' and storage_path is null)))
);
```

- 直传文件回执：`storage_path is null`，字节仅在接收端本地，不占云端配额、无对象可清理。
- `space_used_bytes` 改为只统计 `storage_path is not null` 的文件，直传回执不计入 2GB 空间上限。
- 既有迁移文件不动；该迁移幂等追加。

## 5. Edge Function 变更

### 5.1 新增 `create-p2p-item`（verify_jwt = true）

直传成功后由**发送方**调用，写入一条 `transport='p2p'` 的回执条目，两端经 Realtime 同步看到（列表中带"局域网直传"标识）：

- 鉴权：`requireSpaceAccess`（owner 或设备令牌）。
- 入参：`{ transferSpaceId, kind, originalFilename?, mimeType?, fileSize?, text?, title? }`，校验内联复用 create-upload-url 的规则（大小 ≤2GB、文件名 ≤180、危险 MIME 拒绝、文本 ≤100k）。
- 行为：文件回执只存元数据；文本回执存 `text_content`（与普通文本条目结构一致）。`expires_at` 跟随空间。

### 5.2 既有函数防护

- `get-download-url`、`create-file-share-link`：拒绝 `transport='p2p'` 的文件条目，错误码 `P2P_ITEM_NOT_DOWNLOADABLE`（"该文件为局域网直传，未存储于云端"）。
- `delete-transfer-item`、`cleanup-expired-spaces`：已按 `storage_path` 条件判断，直传回执（null storage_path）天然安全，无需改动。
- `pair-device`：已返回 `deviceId`，无需改动。

`supabase/config.toml` 增加 `[functions.create-p2p-item] verify_jwt = true`。

## 6. 传输状态机与回退

```
sender: idle →(peer 在线?)→ intent 广播 → 等 intent-ack ≤ 8s
   ├─ 超时/nack/无在线对端 ─────────────► 云链路（现有 addFiles/chooseFiles 流程）
   └─ ack → 建 RTCPeerConnection + DataChannel
        → 交换 offer/answer/ICE ≤ 8s → connected → transferring
              ├─ 分块发送（bufferedAmount 流控），双端进度
              ├─ 接收端按 size 收满 → 校验 sha256 → done/error
              └─ 超时（建连 8s / 无进度 30s）/ 异常 → 中断 → sender 走云链路
transferring 成功 → sender 调 create-p2p-item 记回执 → 两端列表出现条目（transport=p2p）
```

- **回退规则**：任意阶段失败或超时，sender 对该次发送**从头走云端流程**（create-upload-url → PUT → complete-upload / create-text-item），用户无感知，仅在 UI 上把模式标识从"局域网直传"切为"云端传输"。
- **在线预判**：超过 `PEER_STALE_MS` 未收到对端 `hello` 心跳时直接走云端，不尝试直传，省去无谓的 8s 等待。
- **文本直传**：字节走 DataChannel；回执走 `create-p2p-item`（含 `text_content`），与云端文本条目体验一致。
- **直传回执条目**：`transport='p2p'` 文件条目在两端列表显示"局域网直传 · 未入云"徽标，无下载/分享按钮；文本条目可正常查看复制。

## 7. 客户端实现

### 7.1 apps/web（无新依赖，浏览器原生 WebRTC）

- 新增 `src/lib/p2p.ts`：SignalClient（私有广播通道订阅、心跳、对端表）+ P2PTransfer（PC 生命周期、DataChannel 收发、分块、sha256、进度回调、超时）。
- `src/app/page.tsx` 接线：
  - 空间建立后启动心跳与信令订阅；`get-space-state` 的 devices 与心跳对端表合并出"在线手机"。
  - `addFiles` / `sendText` 改为"先尝试直传（目标：唯一在线手机；多台在线时提供目标选择器）→ 失败走现有云流程"。
  - 接收直传：文件收到后**不自动下载**（浏览器需用户手势），渲染内联横幅"已通过局域网直传收到 X → [保存] [丢弃]"；文本显示"点击复制"按钮。
  - 模式标识：头部徽标（"局域网直传可用 / 云端传输中"），上传行加模式 tag。
- 无新增 npm 依赖、无构建变更。

### 7.2 apps/mobile（需原生模块，必须重新构建 APK）

- 依赖：`react-native-webrtc`（版本需与 Expo SDK 53 / RN 0.79.6 验证兼容；新架构支持情况见 §9），`app.json` 注册其 config plugin（DataChannel 模式无需相机/麦克风权限）。
- 新增 `src/p2p.ts`：与 web 同构的信令/传输客户端（`from` 用 `deviceId`）。
- `App.tsx` 接线：
  - 配对成功后启动心跳与信令订阅（`AppState` 前台时运行）；`bootstrap` 将 `pair-device` 返回的 `deviceId` 一并持久化。
  - `chooseFiles` / `fromClipboard` 改为先直传后云回退（目标恒为 `web`）。
  - 接收直传：文件分块写入 App 文档目录（避免整文件驻内存，并在 App 重启后保留）→ 校验 sha256 → 本地索引记录 → 横幅"已通过局域网直传收到 X"→ 点击走系统分享/打开或主动移除；文本自动写入剪贴板并横幅提示。
  - 模式标识：顶部横幅（"局域网直传"状态）；列表条目按 `transport` 字段加徽标（查询增加该列）。
- **构建**：`pnpm --filter @quickdrop/mobile build:apk`（EAS）重新出 APK；此后 Expo Go 无法运行本 App，开发需 `expo run:android` 或 EAS dev client。

### 7.3 packages/shared

- 新增 `src/signaling.ts`：§3 的消息 zod schema、常量、`signalChannel(spaceId)`、`parseSignalTopic`。
- 新增测试：schema 校验、topic 解析、常量一致性。

## 8. 部署与运维变更

- `supabase db push` 应用迁移 4；部署 `create-p2p-item`（仅此一个新 function）。
- Web 端仅前端代码，Vercel 正常发布。
- APK 必须经 EAS 重建（新增原生模块）。`docs/deployment.md` 增补本步骤。

## 9. 风险与待确认

| 风险 | 影响 | 缓解/备注 |
|---|---|---|
| `realtime.messages` topic 实际值带不带 `realtime:` 前缀 | 策略不匹配、信令全断 | 策略正则兼容两种形态；实施首日以探测脚本验证 topic 实际值 |
| react-native-webrtc 与 RN 0.79 / Expo 53 新架构兼容性 | 构建失败/闪退 | 选型阶段验证；必要时 app.json 关闭 newArch 或锁版本 |
| Android 无 mDNS，host candidate 暴露局域网 IP | 信令内可见 LAN IP | 仅空间成员可读信令；文档标注 |
| 超过 64MB 的文件 | 浏览器内存风险 | 直传 v1 不尝试发送，直接改走私有云端；云端仍支持 2GB |
| App 退后台后 Realtime/WebRTC 挂起 | 直传中断 | v1 限前台传输；App 退后台主动取消直传、清除未完成本地文件，发送方回退云端 |
| 接收端浏览器自动保存受手势限制 | 文件滞留内存 | 内联横幅 + 用户点击保存（§7.1） |
| 直传回执条目膨胀（无云端字节成本） | 列表可被刷 | 复用空间生命周期清理；后续可加限流（可选） |

若 4.1 的 `realtime.messages` 策略在托管实例上不可用（官方文档支持，但以实测为准），备用方案：Postgres `signaling_messages` 表 + `postgres_changes` 订阅 + 60s TTL 定时清理，鉴权模型不变。

## 10. 实施顺序

1. 迁移（§4）+ `is_space_member`/topic 解析 + `space_used_bytes` 修正；部署后以 curl/REPL 验证 topic 值。
2. `packages/shared` 信令协议 + 测试。
3. Edge Function `create-p2p-item` + 既有函数防护（§5.2）+ config.toml。
4. Web 端 p2p 客户端 + 页面接线 + 模式 UI + 回执调用。
5. Mobile 端依赖/plugin + p2p 客户端 + App 接线 + 模式 UI；EAS 重建 APK。
6. 手工验收：同网直传（≤64MB 文件/文本双向）、大于 64MB 与异网回退、直传中撤销设备、多手机目标选择、空间过期后信令失效、手机重启后可打开已收到的直传文件。
