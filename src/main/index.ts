import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type {
  CaptureMode,
  DeviceInfo,
  DeviceScreen,
  EditKey,
  MainEvent,
  NavKey,
  StreamStats,
  SwipeAction,
  TouchPoint
} from '@shared/types'
import { listDevices, readScreen, watchDevices } from './devices'
import { startScreenrecord } from './screenrecord'
import { startMinicap } from './minicap'
import { keyEvent, KeyCode, swipe, tap, toDevicePoint, type KeyCodeValue } from './input'
import { sendEditKey, sendText } from './keyboard'
import { adbRunOn } from './adb'
import { enableScreenPower, restoreScreenPower } from './screen-power'
import * as wireless from './wireless'

let mainWindow: BrowserWindow | undefined
let stopWatch: (() => void) | undefined

/** 画面尺寸，随采集回调实时更新 */
interface FrameSize {
  width: number
  height: number
}

/** 当前投屏会话 */
interface StreamSession {
  deviceId: string
  mode: CaptureMode
  stop: () => void
  /** 设备的竖屏基准尺寸与旋转角 */
  screen?: DeviceScreen
  /** 实际画面尺寸（可能小于设备物理分辨率），坐标换算必须用它 */
  frame: FrameSize
}
let session: StreamSession | undefined

/** 导航键到 Android keyevent 码的映射 */
const NAV_KEY_CODES: Record<NavKey, KeyCodeValue> = {
  back: KeyCode.BACK,
  home: KeyCode.HOME,
  appSwitch: KeyCode.APP_SWITCH,
  volumeUp: KeyCode.VOLUME_UP,
  volumeDown: KeyCode.VOLUME_DOWN,
  power: KeyCode.POWER
}

/** 统计信息：每秒算一次帧率 */
let stats: StreamStats = { frames: 0, fps: 0, width: 0, height: 0 }
let lastStatsAt = Date.now()
let framesSinceStats = 0

function send(event: MainEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('main-event', event)
  }
}

/** 当前投屏设备是否处于横屏（90 或 270 度） */
function isRotated(): boolean {
  const rotation = session?.screen?.rotation
  return rotation === 90 || rotation === 270
}

/**
 * 把画布坐标换算成设备坐标。
 *
 * 画面通常是缩小过的（设备 1440 宽、画面只有 720 宽），
 * 必须按画面尺寸放大回去，否则点击会落到屏幕左上角。
 * 没有会话信息时原样返回，避免异常情况下把点击丢掉。
 */
function mapPoint(point: TouchPoint): TouchPoint {
  const current = session
  if (!current?.screen) return point
  const screen = current.screen
  return toDevicePoint(point, current.frame, screen, isRotated())
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 360,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // WebCodecs 需要非沙箱渲染进程才能拿到硬件解码路径
      sandbox: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = undefined
    stopSession()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function stopSession(): void {
  if (!session) return
  session.stop()
  // 息屏投屏开过的话，退出会话时还原亮度和锁屏超时
  void restoreScreenPower(session.deviceId)
  session = undefined
  send({ type: 'stream-status', status: 'stopped' })
}

/** 读取设备 ABI 与 SDK 等级，minicap 二进制要按这两个值挑 */
async function readDeviceProfile(deviceId: string): Promise<{ abi: string; sdk: number }> {
  const abi = (await adbRunOn(deviceId, ['shell', 'getprop', 'ro.product.cpu.abi'], 8_000)).trim()
  const sdkRaw = (await adbRunOn(deviceId, ['shell', 'getprop', 'ro.build.version.sdk'], 8_000)).trim()
  const sdk = Number(sdkRaw)
  return { abi: abi || 'arm64-v8a', sdk: Number.isFinite(sdk) && sdk > 0 ? sdk : 33 }
}

function recordFrame(width: number, height: number): void {
  stats.frames += 1
  framesSinceStats += 1
  stats.width = width
  stats.height = height

  const now = Date.now()
  if (now - lastStatsAt >= 1_000) {
    stats.fps = Math.round((framesSinceStats * 1000) / (now - lastStatsAt))
    framesSinceStats = 0
    lastStatsAt = now
    send({ type: 'stream-stats', stats: { ...stats } })
  }
}

/**
 * 启动投屏。
 *
 * 采集方式按系统版本自动选择：
 * Android 10 及以上用 screenrecord（系统自带，minicap 在这些系统上因
 * SurfaceFlinger 接口被移除而无法运行），更老的系统仍可用 minicap。
 */
async function startSession(deviceId: string, targetWidth?: number, preferFps?: boolean): Promise<void> {
  stopSession()
  send({ type: 'stream-status', status: 'starting' })

  try {
    const { abi, sdk } = await readDeviceProfile(deviceId)
    const screen = await readScreen(deviceId)
    stats = { frames: 0, fps: 0, width: 0, height: 0 }
    framesSinceStats = 0
    lastStatsAt = Date.now()

    const useScreenrecord = sdk >= 29
    const mode: CaptureMode = useScreenrecord ? 'screenrecord' : 'minicap'

    // 流畅优先：提高采集码率让编码器不丢帧。720p 时 8M 已充裕，
    // 更高分辨率再给到 12M，否则 USB/无线带宽会反过来成为瓶颈。
    const bitRate = preferFps ? (targetWidth && targetWidth > 720 ? 12_000_000 : 8_000_000) : undefined

    // 画面尺寸在采集过程中才确定，先用设备尺寸兜底
    const frame: FrameSize = {
      width: screen?.width ?? 0,
      height: screen?.height ?? 0
    }
    const current: StreamSession = {
      deviceId,
      mode,
      screen,
      frame,
      stop: () => {}
    }

    if (useScreenrecord) {
      current.stop = await startScreenrecord(
        { deviceId, targetWidth, bitRate },
        {
          onSize: (size) => {
            frame.width = size.width
            frame.height = size.height
          },
          onConfig: (config) => send({ type: 'decoder-config', config }),
          onFrame: (packet) => {
            recordFrame(frame.width, frame.height)
            send({
              type: 'video-packet',
              packet: {
                // 结构化克隆直传二进制，省掉每帧 base64 编解码
                data: packet.data,
                keyframe: packet.keyframe,
                timestamp: Date.now()
              }
            })
          },
          onError: (err) => {
            send({ type: 'stream-status', status: 'error', message: err.message, mode })
          }
        }
      )
    } else {
      current.stop = await startMinicap(
        { deviceId, abi, sdk, targetWidth, fps: preferFps ? 60 : 30 },
        (jpegFrame) => {
          frame.width = jpegFrame.width
          frame.height = jpegFrame.height
          recordFrame(jpegFrame.width, jpegFrame.height)
          // minicap 出的是完整 JPEG，直接给渲染层当图片帧显示
          send({
            type: 'video-packet',
            packet: {
              data: jpegFrame.jpeg,
              keyframe: true,
              timestamp: Date.now()
            }
          })
        },
        (err) => {
          send({ type: 'stream-status', status: 'error', message: err.message, mode })
        }
      )
    }

    session = current
    send({ type: 'stream-status', status: 'streaming', mode })
  } catch (err) {
    send({ type: 'stream-status', status: 'error', message: (err as Error).message })
  }
}

function registerIpc(): void {
  ipcMain.handle('devices:list', (): Promise<DeviceInfo[]> => listDevices())

  ipcMain.handle('stream:start', async (_e, deviceId: string, targetWidth?: number, preferFps?: boolean) => {
    await startSession(deviceId, targetWidth, preferFps)
  })

  ipcMain.handle('stream:stop', () => {
    stopSession()
  })

  ipcMain.handle('input:tap', async (_e, deviceId: string, point: TouchPoint) => {
    await tap(deviceId, mapPoint(point))
  })

  ipcMain.handle('input:swipe', async (_e, deviceId: string, action: SwipeAction) => {
    await swipe(deviceId, {
      from: mapPoint(action.from),
      to: mapPoint(action.to),
      durationMs: action.durationMs
    })
  })

  ipcMain.handle('input:key', async (_e, deviceId: string, key: NavKey) => {
    await keyEvent(deviceId, NAV_KEY_CODES[key])
  })

  ipcMain.handle('input:text', async (_e, deviceId: string, text: string) => {
    await sendText(deviceId, text)
  })

  ipcMain.handle('input:edit-key', async (_e, deviceId: string, key: EditKey) => {
    await sendEditKey(deviceId, key)
  })

  ipcMain.handle('screen-power:set', async (_e, deviceId: string, on: boolean) => {
    if (on) {
      await enableScreenPower(deviceId)
    } else {
      await restoreScreenPower(deviceId)
    }
  })

  ipcMain.handle('wireless:scan', () => wireless.scanServices())
  ipcMain.handle('wireless:pair', (_e, ip: string, port: number, code: string) =>
    wireless.pair(ip, port, code)
  )
  ipcMain.handle('wireless:connect', (_e, ip: string, port: number) => wireless.connect(ip, port))
  ipcMain.handle('wireless:disconnect', (_e, ip: string, port: number) =>
    wireless.disconnect(ip, port)
  )
  ipcMain.handle('wireless:from-usb', (_e, deviceId: string) => wireless.bridgeFromUsb(deviceId))

  // 紧凑窗口：按画面宽高比把窗口缩到贴身大小（侧栏收起 + 小窗用）；
  // 传 null 恢复默认尺寸
  ipcMain.handle('window:compact', (_e, ratio: number | null) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) {
      mainWindow.setSize(1280, 860)
      mainWindow.center()
      return
    }
    // 竖屏画面按高度 720 算宽度，横屏按宽度 900 算高度；再留出 header/键位条 chrome
    const chromeHeight = 96
    let width: number
    let height: number
    if (ratio < 1) {
      height = 720 + chromeHeight
      width = Math.round(720 * ratio)
    } else {
      width = 900
      height = Math.round(900 / ratio) + chromeHeight
    }
    mainWindow.setMinimumSize(300, 300)
    mainWindow.setSize(Math.max(300, width), Math.max(300, height))
    mainWindow.center()
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  // 投屏中把轮询降到 4s：轮询每轮要起多个 adb 进程，会和高帧率采集抢 CPU。
  // setInterval 的间隔在每次到期时重新计算，投屏状态变了自然生效。
  stopWatch = watchDevices(
    (devices) => {
      send({ type: 'devices-changed', devices })
    },
    () => (session ? 4_000 : 2_000)
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopSession()
  stopWatch?.()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopSession()
  stopWatch?.()
})
