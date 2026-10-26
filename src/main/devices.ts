import type { DeviceInfo, DeviceScreen, DeviceState } from '@shared/types'
import { adbRunOn, adbExec } from './adb'
import { isWirelessId } from './wireless-parse'

/** 读取单台设备的属性，失败时返回空对象（设备可能刚掉线） */
async function readProperties(deviceId: string): Promise<Record<string, string>> {
  try {
    const raw = await adbRunOn(deviceId, ['shell', 'getprop'], 8_000)
    const props: Record<string, string> = {}
    // 输出形如：[ro.product.model]: [Pixel 7]
    const re = /^\[([^\]]+)\]:\s*\[([^\]]*)\]$/gm
    let match: RegExpExecArray | null
    while ((match = re.exec(raw)) !== null) {
      props[match[1]] = match[2]
    }
    return props
  } catch {
    return {}
  }
}

/** 读取屏幕尺寸与旋转角度 */
export async function readScreen(deviceId: string): Promise<DeviceScreen | undefined> {
  try {
    // 优先用 wm size 拿到「应用可用区域」，minicap 也是按这个尺寸出图
    const sizeOut = await adbRunOn(deviceId, ['shell', 'wm', 'size'], 8_000)
    const normal = /Override size:\s*(\d+)x(\d+)/.exec(sizeOut) ?? /Physical size:\s*(\d+)x(\d+)/.exec(sizeOut)
    if (!normal) return undefined

    let width = Number(normal[1])
    let height = Number(normal[2])
    // wm size 在横屏时也会被写成横屏值，此时以 dumpsys 的旋转角度为准做换算
    const rotation = await readRotation(deviceId)
    if (rotation === 90 || rotation === 270) {
      // 保证 width/height 是「竖屏基准」，旋转信息单独给出
      const shortSide = Math.min(width, height)
      const longSide = Math.max(width, height)
      width = shortSide
      height = longSide
    }
    return { width, height, rotation }
  } catch {
    return undefined
  }
}

/** 读取当前旋转角度 */
async function readRotation(deviceId: string): Promise<DeviceScreen['rotation']> {
  try {
    const out = await adbRunOn(deviceId, ['shell', 'dumpsys', 'input'], 8_000)
    // Android 12+：SurfaceOrientation: 0/1/2/3；旧版本还有 mPortraitRotation 之类
    const match = /SurfaceOrientation:\s*([0-3])/.exec(out)
    const index = match ? Number(match[1]) : 0
    const table: DeviceScreen['rotation'][] = [0, 90, 180, 270]
    return table[index] ?? 0
  } catch {
    return 0
  }
}

function toDeviceState(raw: string): DeviceState {
  switch (raw) {
    case 'device':
      return 'device'
    case 'offline':
      return 'offline'
    case 'unauthorized':
      return 'unauthorized'
    case 'bootloader':
      return 'bootloader'
    default:
      return 'unknown'
  }
}

/** 枚举当前 adb 能看到的所有设备，并补齐型号、系统版本与屏幕信息 */
export async function listDevices(): Promise<DeviceInfo[]> {
  const { stdout } = await adbExec(['devices', '-l'])
  const lines = stdout.split(/\r?\n/).slice(1)

  const devices: DeviceInfo[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('*')) continue

    const parts = trimmed.split(/\s+/)
    const id = parts[0]
    const state = toDeviceState(parts[1] ?? 'unknown')
    const extra: Record<string, string> = {}
    for (const token of parts.slice(2)) {
      const idx = token.indexOf(':')
      if (idx > 0) extra[token.slice(0, idx)] = token.slice(idx + 1)
    }

    const info: DeviceInfo = { id, state, model: extra.model, wireless: isWirelessId(id) }
    if (state === 'device') {
      const props = await readProperties(id)
      info.model = props['ro.product.model'] ?? extra.model ?? props['ro.product.device']
      info.brand = props['ro.product.brand']
      info.androidVersion = props['ro.build.version.release']
      const sdk = Number(props['ro.build.version.sdk'])
      info.sdk = Number.isFinite(sdk) ? sdk : undefined
      info.screen = await readScreen(id)
    }
    devices.push(info)
  }
  return devices
}

/** 轮询设备列表，变化时回调（USB 插拔驱动）。intervalMs 支持传函数，每轮动态取值 */
export function watchDevices(
  onChange: (devices: DeviceInfo[]) => void,
  intervalMs: number | (() => number) = 2_000
): () => void {
  let lastKey = ''
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let running = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    if (running) return
    running = true
    try {
      const devices = await listDevices()
      const key = JSON.stringify(devices)
      if (key !== lastKey) {
        lastKey = key
        if (!stopped) onChange(devices)
      }
    } catch (err) {
      console.warn('[devices] 轮询失败：', (err as Error).message)
    } finally {
      running = false
    }
  }

  const nextDelay = (): number => (typeof intervalMs === 'function' ? intervalMs() : intervalMs)

  const schedule = (): void => {
    timer = setInterval(() => void tick(), nextDelay())
  }

  void tick()
  schedule()

  return () => {
    stopped = true
    if (timer) clearInterval(timer)
  }
}
