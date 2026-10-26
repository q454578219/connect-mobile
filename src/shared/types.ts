/**
 * 手机屏幕的坐标空间描述。
 *
 * 投屏画面可能被旋转（横屏 App），触摸注入必须使用「当前旋转角度」下的尺寸，
 * 否则点击会整体偏移，所以这里把尺寸和旋转放在一起传。
 */
export interface DeviceScreen {
  /** 竖屏基准宽度（px） */
  width: number
  /** 竖屏基准高度（px） */
  height: number
  /** 当前旋转角度：0 / 90 / 180 / 270 */
  rotation: 0 | 90 | 180 | 270
}

export type DeviceState = 'device' | 'offline' | 'unauthorized' | 'bootloader' | 'unknown'

/** 一台通过 adb 看到的设备 */
export interface DeviceInfo {
  /** adb 序列号 */
  id: string
  /** adb 的连接状态 */
  state: DeviceState
  /** 型号（如 Pixel 7） */
  model?: string
  /** 品牌 */
  brand?: string
  /** 系统版本 */
  androidVersion?: string
  /** SDK 等级 */
  sdk?: number
  /** 当前屏幕参数，未连接成功时为空 */
  screen?: DeviceScreen
  /** 是否通过 WiFi 无线连接（序列号形如 ip:port） */
  wireless?: boolean
}

/** 投屏会话的运行状态 */
export type StreamStatus = 'starting' | 'streaming' | 'stopped' | 'error'

/** 画面采集方式 */
export type CaptureMode = 'screenrecord' | 'minicap'

/** 渲染进程初始化解码器所需的信息 */
export interface DecoderConfig {
  /** WebCodecs codec 字符串，如 avc1.42c029 */
  codec: string
  /** avcC（AVCDecoderConfigurationRecord）的 base64 */
  avcC: string
  /** 编码尺寸 */
  width?: number
  height?: number
}

/** 一帧画面数据 */
export interface VideoPacket {
  /** AVCC 格式的 H.264 帧数据（minicap 路径则是完整 JPEG） */
  data: Uint8Array
  /** 是否关键帧 */
  keyframe: boolean
  /** 采集时刻（渲染进程用作时间戳） */
  timestamp: number
}

export interface StreamStats {
  /** 已收到的帧数 */
  frames: number
  /** 实测帧率 */
  fps: number
  /** 画面宽高 */
  width: number
  height: number
}

/** 触摸动作的坐标点 */
export interface TouchPoint {
  x: number
  y: number
}

export interface SwipeAction {
  from: TouchPoint
  to: TouchPoint
  /** 滑动耗时（ms） */
  durationMs: number
}

/** 导航按键 */
export type NavKey = 'back' | 'home' | 'appSwitch' | 'volumeUp' | 'volumeDown' | 'power'

/** 编辑类按键，对应手机输入法上的常用操作 */
export type EditKey =
  | 'enter'
  | 'backspace'
  | 'delete'
  | 'tab'
  | 'escape'
  | 'space'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'

/** 局域网里 mDNS 发现的 adb 无线服务 */
export interface MdnsService {
  ip: string
  port: number
  /** connect = 可直接连接；pair = 配对服务（需先输配对码） */
  kind: 'connect' | 'pair'
}

/** 主进程 → 渲染进程的事件 */
export type MainEvent =
  | { type: 'devices-changed'; devices: DeviceInfo[] }
  | { type: 'stream-status'; status: StreamStatus; message?: string; mode?: CaptureMode }
  | { type: 'decoder-config'; config: DecoderConfig }
  | { type: 'video-packet'; packet: VideoPacket }
  | { type: 'stream-stats'; stats: StreamStats }

/** 主进程暴露给渲染进程的 API（经 preload 桥接） */
export interface DesktopApi {
  listDevices(): Promise<DeviceInfo[]>
  /** preferFps：流畅优先——提高采集码率/帧率，代价是带宽占用变大 */
  startStream(deviceId: string, targetWidth?: number, preferFps?: boolean): Promise<void>
  stopStream(): Promise<void>
  tap(deviceId: string, point: TouchPoint): Promise<void>
  swipe(deviceId: string, action: SwipeAction): Promise<void>
  pressKey(deviceId: string, key: NavKey): Promise<void>
  /** 发送一段文本（英文、数字与符号；中文请用手机自己的输入法） */
  sendText(deviceId: string, text: string): Promise<void>
  /** 发送编辑按键（回车、退格、方向键等） */
  sendEditKey(deviceId: string, key: EditKey): Promise<void>
  /** 开启息屏投屏（压低亮度 + 延长锁屏），停止投屏时自动还原 */
  setScreenPower(deviceId: string, on: boolean): Promise<void>
  /** 局域网 mDNS 扫描 adb 无线服务 */
  wirelessScan(): Promise<{ services: MdnsService[]; supported: boolean }>
  /** 配对码配对（Android 11+ 无线调试） */
  wirelessPair(ip: string, port: number, code: string): Promise<void>
  /** 连接无线设备 */
  wirelessConnect(ip: string, port: number): Promise<string>
  /** 断开无线设备 */
  wirelessDisconnect(ip: string, port: number): Promise<void>
  /** USB 一键转无线（Android 10-），返回连接后的设备 id */
  wirelessFromUsb(deviceId: string): Promise<string>
  /** 把窗口缩放到贴合画面比例的紧凑尺寸（不留边距），null 恢复默认尺寸 */
  compactWindow(ratio: number | null): Promise<void>
  onEvent(listener: (event: MainEvent) => void): () => void
}
