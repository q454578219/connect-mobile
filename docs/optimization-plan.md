# Connect Mobile 功能优化清单与无线投屏方案

> 整理日期：2026-10-23
> 状态：待实施（本文档仅作记录，未动代码）
> 更新（2026-10-26）：项目已纳入 git 并公开（MIT），文中的 P0 编译问题已修复，`pnpm typecheck` 现已通过；其余条目仍按原样保留作历史记录。

---

## 一、项目现状概述

Electron 桌面应用（TypeScript + React，pnpm + electron-vite），通过 USB + ADB 把 Android 手机投屏到电脑：

- **采集**：Android 10+ 走 `adb exec-out screenrecord --output-format=h264`（180s 自动重启），旧系统走 minicap JPEG 回退
- **传输**：主进程 Annex-B → AVCC 转封装 → base64 字符串过 IPC → 渲染进程 WebCodecs `VideoDecoder` 解码 → canvas 绘制
- **控制**：每次 tap/swipe/keyevent 都新起一个 `adb shell input` 子进程，坐标按帧尺寸/旋转角换算
- **规模**：约 4k 行代码，零多余运行时依赖，有 22 个单测（`scripts/self-test.mjs`）+ 5 个 e2e 脚本

---

## 二、问题清单（按优先级）

### P0 · 编译已坏（遗留代码，必须先修）

| # | 问题 | 位置 |
|---|------|------|
| 1 | `ime-status` 事件分支调用了从未声明的 `setImeStatus`，`<KeyboardInput>` 被传了它不支持的 `imeStatus` prop —— **`pnpm typecheck` 当前失败**，运行时收到该事件会抛 ReferenceError。这是删除 ADBKeyboard（中文输入）功能时留下的残渣 | `src/renderer/src/App.tsx:75-76, 234` |
| 2 | `fetch-ime`、`test:chinese` 两个 npm script 指向不存在的文件（`scripts/fetch-adbkeyboard.mjs`、`scripts/verify-chinese.cjs`） | `package.json:9, 20` |
| 3 | README 仍在描述已删除的 ADBKeyboard 中文输入流程 | `README.md:64, 90-101` |
| 4 | `ws` 是生产依赖但只被 e2e 测试脚本使用，应移到 devDependencies | `package.json:23-25` |

### P1 · 正确性问题

1. **中途旋转手机会点错位置**：旋转角只在会话启动时读一次（`src/main/index.ts:153`、`src/main/devices.ts:47-58`），之后永不刷新。横屏后 tap 坐标映射全错，需重启会话。
2. **startSession 竞态**：`startSession` 无世代守卫，快速连点两次「开始投屏」时，慢的那次启动完成后会无条件 `session = current`（`src/main/index.ts:222`）覆盖新会话，导致帧回调发错设备。
3. **投屏中切换设备**：允许选中另一台设备（`App.tsx:196-210`），tap 会发给新设备，但 `mapPoint` 用的还是旧会话的 frame/screen（`src/main/index.ts:74-79`）——坐标按错误设备换算。
4. **流出错后 session 不清理**：`onError` 只发 `stream-status: error`（`src/main/index.ts:194-197`），残留死会话，stats/canControl 逻辑不一致。
5. **minicap 渲染竞态**：每帧 `Blob` + `createObjectURL` + `new Image()` 异步解码（`App.tsx:91-107`），旧帧 onload 可能晚于新帧完成并覆盖画面，无 latest-frame-wins 守卫。改用 `createImageBitmap` + 代际计数可解。

### P1 · 性能问题（收益最大的两个点）

1. **每帧 base64 过 IPC**：主进程每帧 `Buffer.toString('base64')`（`src/main/index.ts:188, 210`），渲染进程 `atob` + 逐字节拷贝（`src/renderer/src/hooks/useH264Player.ts:175-180`）。体积膨胀 33% + 双端 CPU 开销，在 100+ fps 下是全管线最大的纯开销。**改用 `MessagePortMain` / `postMessage` 直传 `ArrayBuffer` 可零拷贝**。
2. **每解一帧都 `setState`**：`useH264Player.ts:75-80` 每帧更新 React state，整棵组件树按帧率重渲染。宽高只在配置变化时才变，帧计数应挂在每秒一次的 stats tick 上或改用 ref。

### P2 · 健壮性 / 体验

1. **无自动重连**：拔线后只报一次错，重新插上后 `watchDevices` 能检测到但没有恢复逻辑，需手动重开投屏。
2. **tap/swipe 每次新起 adb 进程**，无队列无合并（`src/main/input.ts:18-47`），Windows 上进程创建 50~150ms，快速点击会堆积。建议串行队列或 minitouch/scrcpy 式 socket。
3. **解码积压处理粗暴**：队列 >8 帧就 `decoder.reset()` + 重配（`useH264Player.ts:130-144`），要等下一个关键帧，可能卡屏数秒。不如在入口丢弃非关键帧（跳过 `append`）。
4. **无端到端背压**：主进程无条件转发每帧，`AnnexBSplitter`/`FrameAssembler` 缓冲在 IPC 慢时会无界增长（`src/main/h264.ts:51, 314`）。
5. **设备轮询开销**：每 2s 对每台设备串行发 3+ 个 adb 子进程（getprop/wm size/dumpsys，`src/main/devices.ts:96-107, 110-141`）。可改 `adb track-devices` 或缓存属性。
6. **180s 重启间隙**：screenrecord 的 3 分钟上限是系统限制，但重启时重复 `resolveSize()` adb 往返（8s 超时），可缓存尺寸。
7. **会话启动早期 mapPoint 落空**：`session = current` 在异步启动完成后才赋值（`src/main/index.ts:222`），之前到达的帧/点击会静默退化为未换算的原始坐标。

### P3 · 打磨项

- 静默吞异常：`devices.ts:16-18, 41-43, 55-57`，设备信息读取失败退化为 `{0,0}`，点击错位无任何诊断
- 音量键 keyevent 已实现（`input.ts:58-59`）但 UI 没有按钮（`App.tsx:15-20` NAV_KEYS），加两行即可
- 设置不持久化：分辨率每次启动重置回 720，无 localStorage/electron-store
- 硬编码超时分散各处（8s/10s/15s），不可配置
- e2e 脚本硬编码 `resources/tools/adb.exe`、默认 `emulator-5554`，忽略 `CONNECT_MOBILE_ADB`
- `fetch-tools.mjs` 下载无校验和固定（供应链小风险）
- 渲染进程传来的 tap 坐标未校验（NaN 可达 adb）
- Windows 下只有 `child.kill()` 无 `taskkill /T` 树杀，异常退出可能残留 adb/screenrecord 子进程
- `sandbox: false`（`src/main/index.ts:94`，WebCodecs 硬解需要）建议加注释链接说明
- `renderer/env.d.ts` 冗余重复声明 `startStream`

### 功能空白（相对 scrcpy 等成熟方案）

无音频投屏、无 WiFi 无线连接、无剪贴板同步、无多设备同屏、无全屏/置顶窗口、无 H.265（HEVC）。

---

## 三、WiFi 无线投屏实现方案（已评审，待实施）

### 结论

- **蓝牙不可行**：蓝牙带宽 1~2 Mbps、延迟抖动大，装不下视频流，且 ADB 无蓝牙传输通道。
- **采用 ADB over TCP/IP**：`adb connect` 后无线设备以 `IP:端口` 形式出现在 `adb devices`，而现有全链路（枚举、采集、控制）都走 `adb -s <id>`，**投屏/控制代码几乎零改动**。

### 两条路径

| Android 版本 | 方式 | 前提 |
|---|---|---|
| **11+** | 「开发者选项 → 无线调试」生成配对码，应用内 `adb pair` + `adb connect`；可用 `adb mdns services` 自动扫描局域网设备（连 IP 都不用手输） | 无需插线 |
| **≤10** | 无配对协议：先插一次 USB，应用内一键 `adb tcpip 5555` → 读手机 wlan0 IP → `adb connect ip:5555` → 拔线无线用 | 首次需 USB |

### 实施步骤

**① P0 修复（前置，见上文 P0 清单）** —— 先让 typecheck 恢复绿色。

**② 类型契约**（`src/shared/types.ts`）：

- 新增 `MdnsService { ip: string; port: number; kind: 'connect' | 'pair' }`
- `DeviceInfo` 增加 `wireless?: boolean`（UI 显示 📶 徽标）
- `DesktopApi` 增加 5 个方法：
  - `wirelessScan(): Promise<MdnsService[]>`
  - `wirelessPair(ip, port, code): Promise<void>`
  - `wirelessConnect(ip, port): Promise<void>`
  - `wirelessDisconnect(ip, port): Promise<void>`
  - `wirelessFromUsb(deviceId): Promise<string>`（返回设备 IP）

**③ 主进程新模块 `src/main/wireless.ts`**（解析函数导出为纯函数便于单测）：

1. `scanServices()`：`adb mdns check` 探测支持 → `adb mdns services`，宽容解析（各版本 adb 列数不同），匹配 `_adb-tls-connect`（直接连）/ `_adb-tls-pairing`（需配对）
2. `pair()`：`adb pair ip:port code`，输出含 "Success" 判成功，失败给可读错误（配对码错/窗口超时）
3. `connect()`：`adb connect ip:port`，"connected to / already connected" 成功；"failed" 抛可读错误（含「手机端无线调试未开启」提示）
4. `disconnect()`：`adb disconnect`
5. `bridgeFromUsb()`：`tcpip 5555` → `adb shell ip addr show wlan0`（回退 `ip route`）解析 `inet` → `connect`
6. `src/main/index.ts` 注册 5 个 IPC handler；`devices.ts` 的 `listDevices()` 用正则 `^\d+\.\d+\.\d+\.\d+:\d+$` 识别无线设备并标记 `wireless: true`

**④ preload**（`src/preload/index.ts`）：桥接 5 个方法。

**⑤ 渲染层**：

- 新组件 `src/renderer/src/components/WirelessDialog.tsx`（模态框）：
  - 扫描区：扫描按钮 + 结果列表（connect 服务直接连；仅发现 pairing 服务时引导去配对；不可用时提示手输 IP，注明 Windows 防火墙可能拦 mDNS）
  - 手动连接区：IP + 端口 + 连接按钮
  - 配对区（Android 11+）：IP:端口 + 6 位配对码，说明配对弹窗 1 分钟内有效
  - USB 转无线（Android ≤10）：检测到已授权 USB 设备时显示一键按钮
  - 底部提示：无线延迟/带宽弱于 USB，建议 720p 以下
- `App.tsx`：header 加「无线连接」按钮；设备列表无线设备显示 📶；localStorage 记住上次 IP/端口

**⑥ 测试**：

- `scripts/self-test.mjs` 新增：mDNS 输出解析（多格式）、`ip addr`/`ip route` IP 解析、connect/pair 输出分类、无线 id 正则
- `pnpm typecheck` + `pnpm test` 全绿；`pnpm dev` 冒烟（假 IP 验证错误提示）
- 真机验收：同一 WiFi 下走一遍配对/连接/投屏

**⑦ 文档**：README 补「无线连接」章节（两种模式步骤 + 常见问题：防火墙、配对窗口超时、延迟建议）。

---

## 四、不在本次范围的后续建议

1. P1 正确性修复：会话竞态守卫、中途旋转刷新、切设备强制重启、错误后清 session
2. 性能：IPC 改 `MessagePortMain` 零拷贝传 `ArrayBuffer`、去每帧 `setState`、入口丢帧背压
3. 断线自动重连（watchDevices 已有重插检测，补恢复逻辑即可）
4. 音频投屏（Android 10+ 可用 adb 音频源 + 单独解码播放管线）
5. 剪贴板同步、H.265、多设备同屏
