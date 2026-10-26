# Connect Mobile

通过 USB 或 WiFi 把 Android 手机投屏到电脑，用鼠标点击、滑动、滚轮滚动，用电脑键盘直接打字（英文）。

## 下载

- **Windows 免安装版**：到 [Releases](https://github.com/q454578219/connect-mobile/releases) 下载
  `ConnectMobile-0.1.0-win-x64-portable.zip`，解压后双击 `Connect Mobile.exe` 即可。
  已内置 adb，不需要装 Node 或 Android SDK；**未做代码签名**，SmartScreen 提示「未知发布者」时选「更多信息 → 仍要运行」。
- **从源码跑**：见下方「跑起来」。

## 功能

| 功能 | 说明 |
|---|---|
| 投屏 | H.264 实时画面，USB 下真机实测 100+ fps |
| 无线连接 | 同一 WiFi 下免插线（Android 11+ 配对码 / 老系统 USB 转无线） |
| 点击 | 点画布 = 点手机，坐标精确到像素 |
| 滑动 | 按住拖动，滚列表、翻页；下方也有四向滑动按钮 |
| 滚轮滚动 | 鼠标滚轮自动转成上滑/下滑，翻列表不用按住拖 |
| 手势热键 | 数字键盘 1/2/3/4（顶排数字也可）= 左滑/右滑/上滑/下滑，打字时自动让路 |
| 导航键 | 返回 / 桌面 / 最近任务 / 音量± / 电源（画面下方工具条） |
| 息屏投屏 | 屏幕压到最低亮度继续投屏，退出自动还原 |
| 画面遮罩 | 黑夜/护眼/自定义色调 + 压暗滑杆，只影响电脑显示 |
| 键盘输入 | 电脑键盘直接打字到手机（英文、数字、符号） |
| 界面 | 侧栏可拖拽调宽、可整体收起 |

## 它是怎么工作的

```
┌──────────────────── Electron 主进程 ────────────────────┐
│                                                         │
│  adb devices / adb mdns ──► 设备列表（插拔自动刷新）     │
│                                                         │
│  screenrecord (H.264 裸流)                              │
│      │                                                  │
│      ├─ Annex-B 切 NAL → 收集 SPS/PPS → 拼 avcC         │
│      └─ VCL 切片 → AVCC (长度前缀) → IPC                │
│                              │                          │
│  渲染进程 WebCodecs 解码 ──► VideoFrame ──► canvas 绘制  │
│                                                         │
│  鼠标点击/滚轮 ──► 坐标换算 ──► adb shell input …        │
│  键盘输入 ──► ASCII 走 input text                       │
└─────────────────────────────────────────────────────────┘
```

- **画面采集**：`adb exec-out screenrecord --output-format=h264 -`，系统自带，不用往手机推二进制
- **解码**：渲染进程 WebCodecs（Chromium 内置硬解），不需要 ffmpeg
- **点击注入**：`adb shell input tap`，延迟约 10~40ms
- **键盘输入**：`input text` 只接收 ASCII，中文请用手机自己的输入法
- **无线连接**：ADB over TCP/IP（`adb pair` / `adb connect`），连接后与 USB 设备使用方式完全一致

### 为什么采集不用 minicap

最早选的是 [minicap](https://github.com/openstf/minicap)，但实测发现它在
**Android 10 及以上完全不可用**——依赖的 `SurfaceComposerClient::getBuiltInDisplay`
在 Android 10 被系统删除了，任何版本的 minicap.so 都无法加载（三星/小米新机都复现过）。

所以按系统版本自动分流：

| 系统版本 | 采集方式 |
|---|---|
| Android 10+ | `screenrecord`（H.264 + WebCodecs） |
| Android 9 及以下 | `minicap`（JPEG 逐帧） |

## 环境要求

- Windows 10 / 11
- Node.js ≥ 18
- 一台 Android 手机（USB 调试打开）

## 跑起来

```bash
pnpm install
pnpm fetch-tools    # 首次：下载内置 adb 与 minicap
pnpm dev
```

> 打包成安装包：`pnpm package`（产物在 `release/`）

> **`pnpm fetch-tools` 需要能访问 `dl.google.com` 与 GitHub。** 如果下载不通（国内网络常见），
> 手动把 [platform-tools](https://developer.android.com/tools/releases/platform-tools) 解压后的
> `adb.exe`、`AdbWinApi.dll`、`AdbWinUsbApi.dll` 放进 `resources/tools/` 即可；
> 也可以设置环境变量 `CONNECT_MOBILE_ADB` 指向本机已有的 adb，跳过内置 adb。
> minicap 只在 Android 9 及以下作为回退采集使用，没有它不影响 Android 10+。

## 手机端准备

**USB 连接：**

1. 设置 → 关于手机 → 连点「版本号」7 次，开启开发者选项
2. 开发者选项 → 打开「USB 调试」
3. 插上 USB 线，手机上点「允许 USB 调试」→ 勾选「一直允许」
4. 部分国产 ROM 还需要额外打开「USB 调试（安全设置）」，否则无法模拟点击

**无线连接（同一 WiFi）：**

- **Android 11+（免插线）**：开发者选项 → 打开「无线调试」→ 应用里点「无线连接」→ 扫描后点「连接」；
  首次使用点手机上「使用配对码配对设备」，把弹窗里的 IP、端口、6 位配对码填到应用第 2 步完成配对
- **Android 10 及以下**：先插一次 USB 并连上 WiFi → 应用里点「无线连接」→ 用「USB 转无线」一键切换 → 成功后拔线

> 注意：配对弹窗里的「IP 和端口」与无线调试主页面显示的「IP 和端口」是两个不同的端口。
> 扫描不到设备时检查 Windows 防火墙是否放行 adb，或直接手动输入 IP:端口。

## 使用

1. 左侧选中设备，选投屏宽度（720 是清晰度和流畅度的平衡点）
2. 点「开始投屏」
3. **点画面 = 点手机**，按住拖动 = 滑动，**滚轮 = 上下滚动页面**
4. 画面下方按键条：返回 / 桌面 / 最近任务 / 音量± / 电源 / 息屏投屏
5. 左侧栏可拖动边缘调宽，点 header 的 ☰ / ⇤ 收起或展开

### 息屏投屏

投屏中点画面下方「息屏投屏」：应用会把手机亮度压到最低并临时延长自动锁屏时间，
肉眼看屏幕接近全黑，但投屏仍在继续。退出投屏或再点一次开关即还原亮度与锁屏设置。

> 说明：屏幕背光其实还开着（系统层面仍在渲染编码），所以省电有限；它的价值是夜里不刺眼、
> 不打扰旁人。真正的「熄屏仍在录」需要往手机里推 scrcpy 式服务，与本应用的零部署架构冲突。
> 无线连接下同样可用，但耗电会比 USB 快。

## 项目结构

```
src/
├── main/                     Electron 主进程
│   ├── adb.ts                adb 可执行文件定位与命令执行
│   ├── devices.ts            设备枚举、属性读取、插拔轮询
│   ├── screenrecord.ts       H.264 采集（Android 10+ 主路径）
│   ├── h264.ts               Annex-B 切分、SPS/PPS → avcC、AVCC 封装
│   ├── minicap.ts            minicap 采集（Android 9- 回退）
│   ├── minicap-parser.ts     minicap 流协议解析
│   ├── coords.ts             画面坐标 → 设备坐标换算
│   ├── input.ts              点击、滑动、按键注入
│   ├── keyboard.ts           文本输入与编辑键
│   ├── text-input.ts         ASCII 判定与 shell 转义（纯逻辑）
│   ├── wireless.ts           无线扫描 / 配对 / 连接 / USB 转无线
│   ├── wireless-parse.ts     无线相关 adb 输出解析（纯逻辑）
│   ├── screen-power.ts       息屏投屏（亮度与锁屏超时管理）
│   └── index.ts              窗口、IPC 注册、投屏会话管理
├── preload/index.ts          contextBridge 暴露 window.desktop
├── shared/types.ts           主进程与渲染进程共用的类型契约
└── renderer/                 React UI
    └── src/
        ├── App.tsx                        设备列表、控制栏、事件分发
        ├── hooks/useH264Player.ts         WebCodecs 解码封装
        └── components/
            ├── DeviceCanvas.tsx           canvas 绘制、点击/滚轮 → 手势
            ├── WirelessDialog.tsx         无线连接弹窗（扫描/配对/手动）
            └── KeyboardInput.tsx          键盘捕获、输入框

resources/tools/
├── adb.exe                内置 platform-tools
└── minicap/               各 ABI 的 minicap 预编译产物
```

## 测试

```bash
# 单元测试：H.264 解析、minicap 协议、坐标换算、文本转义、无线解析（无需设备）
pnpm test

# 用真实屏幕数据验证 H.264 解析
pnpm test:h264 [样本文件] [期望宽] [期望高]

# 以下都需要：应用已启动（--remote-debugging-port=9333）+ 手机已连接
# 可通过 TEST_DEVICE=<序列号> 指定设备
pnpm test:e2e          # 投屏出帧
pnpm test:tap          # 点击精度
pnpm test:gestures     # 滑动 + 导航键
pnpm test:keyboard     # 英文/特殊字符/退格
```

## 实现中踩到的坑

这些都是实际调试出来的，写在这里免得以后重犯：

1. **WebCodecs 要求 AVCC，不接受 Annex-B**。`configure()` 给了 `description`(avcC) 后，
   每帧必须带 4 字节大端长度前缀。喂起始码格式会报
   `Unable to determine size of bitstream buffer`。
2. **WebCodecs 只在安全上下文可用**。`data:` URL 页面里 `VideoDecoder` 是 undefined，
   必须用 `file://` 或自定义协议加载页面。
3. **解析 SPS 要跳过 NAL 头字节**。SPS 第 0 字节是 `0x67`，`profile_idc` 从第 1 字节开始，
   不跳过会把分辨率算成 16×32。
4. **`--intra-refresh` 会让 screenrecord 输出异常**。加上后只输出 52 字节就停。
5. **`setPointerCapture` 会吞掉 `pointerup`**。画布上用了指针捕获后收不到抬起事件，
   导致点击能用但滑动无效；监听改挂到 `window` 上解决。
6. **坐标要按画面尺寸缩放回设备尺寸**。设备 1440 宽、画面 720 宽时若原样透传，
   点击会全部偏到左上角 1/4 区域（滑动看起来正常，因为只要坐标在屏幕内就能滚）。
7. **`input keyevent` 传 Unicode 码点打不出中文**。看起来像成功了（界面有变化），
   实际是键盘弹出，字符并没有进去。
8. **screenrecord 静止画面不产帧**。H.264 只在画面变化时编码，这是正常行为，
   但调试时容易误判成链路不通。
9. **无线配对端口 ≠ 连接端口**。配对弹窗显示的是配对服务端口（一次性），
   连接要用无线调试主页面显示的端口，输错会一直 "failed to connect"。
10. **滚轮合成滑动要节流**。`adb shell input` 每次都新起进程（Windows 上 50~150ms），
    滚轮事件高频触发，必须累积增量 + 冷却间隔，否则进程堆积越滚越卡。

## 已知限制

- 只支持 Android（iOS 需要 libimobiledevice + WebDriverAgent，架构完全不同）
- 中文输入不支持（`input text` 只收 ASCII），请在手机上用输入法打中文
- 画面有变化才产帧，静止时帧率统计会掉到 0
- 息屏投屏是「最低亮度」方案，背光仍开启，省电有限
- 无线模式延迟与画质受 WiFi 带宽影响，建议 720p 以下

## 常用调试开关

| 环境变量 | 作用 |
|---|---|
| `CONNECT_MOBILE_ADB` | 指定 adb 可执行文件路径 |
| `TEST_DEVICE` | 端到端测试要操作的设备序列号 |

## 许可证

[MIT](LICENSE) © 2026 LinZuo —— 可自由使用、修改、分发、商用，保留版权声明即可。

## 第三方组件

`resources/tools/` 里的二进制不随仓库分发，由 `pnpm fetch-tools` 下载：

- **adb / platform-tools** — Google，Apache-2.0，随包附带 `NOTICE.txt`
- **minicap** — [openstf/minicap](https://github.com/openstf/minicap)，Apache-2.0

本项目自身代码不含上述组件的派生实现。
