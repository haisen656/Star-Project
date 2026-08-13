# QuickDrop Windows 本机传输助手

本机传输助手（QuickDrop Bridge）不是桌面客户端：没有登录页、没有窗口、没有账号，也不会扫描剪贴板、屏幕或文件。它只是一个在 Windows 后台运行的短生命周期局域网流式中转服务，供已打开的 QuickDrop 网页在传送大文件时调用。

## 传输选择

- 小于 64MB 的文件：上传到私有 Supabase Storage，供所有已配对设备下载。
- 64MB 及以上：若电脑和手机处于同一 Wi‑Fi，优先由 Bridge 流式直传；不会写入 Supabase Storage，也不会整体读入浏览器内存。
- Bridge 未安装、未启动、没有可用 LAN 地址、手机不在线、握手失败或下载失败：原始客户端自动回退到私有 Storage。
- 文本仍可通过原有 WebRTC/私有云端路径同步。

手机上传大文件时，会先通过受权限保护的 Realtime 控制消息请求网页创建一次性 Bridge 会话；Bridge 将手机的原生流式上传暂存到系统临时目录，网页显示“保存到电脑”按钮。临时文件在保存、取消或 10 分钟超时后删除。

## 一次安装（Windows）

需要 Node.js 20+。在仓库根目录以当前用户身份运行：

```powershell
pnpm --filter @quickdrop/bridge build
powershell -ExecutionPolicy Bypass -File apps/bridge/scripts/install-windows.ps1
```

安装脚本只会：复制 `server.mjs` 到 `%LOCALAPPDATA%\QuickDrop\bridge`、注册 `quickdrop-bridge://` 协议、创建当前用户的开机启动项并启动后台服务。首次运行时 Windows 防火墙可能询问是否允许“专用网络”；只应允许专用网络，切勿勾选公用网络。

网页在用户选择大文件时会尝试唤起 `quickdrop-bridge://start`。浏览器可能显示一次外部应用确认；确认后，后续大文件可自动使用已经运行的助手。手机发起大文件上传时浏览器不能静默启动本地程序（这是浏览器安全限制），因此要求助手已通过开机启动项运行；否则手机会直接回退私有云端。

## 协议和安全边界

- Bridge 绑定局域网端口 `47561`，不会暴露到互联网；安装时只允许专用网络防火墙规则。
- 网页的本地控制接口只接受部署站点和本地开发站点 Origin；手机的实际 GET/PUT 只凭每次传输新生成的 256-bit Bearer token。
- token 仅在 Bridge 进程内以 SHA-256 hash 保留十分钟，绝不写入数据库、磁盘、日志或 Supabase Realtime。
- Realtime 只传递端点、一次性 token、文件元数据和完成状态；不传递文件字节。现有私有频道 RLS 仅允许空间所有者与未撤销设备。
- 文件名、MIME、大小仍受 QuickDrop 的 2GB 与危险类型规则约束。Bridge 流式计数并拒绝大小不匹配的请求。
- 局域网 HTTP 依赖 Wi‑Fi 的链路安全；一次性 token 可阻止未授权请求，但不等同于端到端内容加密。不要在不可信公共 Wi‑Fi 使用本机直传；此时让它回退私有 HTTPS 云端。

Bridge 永不保留手机设备令牌、Supabase key、配对码或用户文件的长期副本。
