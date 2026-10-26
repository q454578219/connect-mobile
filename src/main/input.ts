import type { SwipeAction, TouchPoint } from '@shared/types'
import { adbRunOn } from './adb'
import { toDevicePoint, type ScreenSize } from './coords'

export { toDevicePoint }
export type { ScreenSize }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 点击。
 *
 * 用 `input tap` 而不是 minitouch：延迟略高（约 10~40ms）但零依赖、不需要往设备塞进程，
 * 对「点一下图标 / 按一下按钮」这个场景完全够用。
 */
export async function tap(deviceId: string, point: TouchPoint): Promise<void> {
  await adbRunOn(
    deviceId,
    ['shell', 'input', 'tap', String(Math.round(point.x)), String(Math.round(point.y))],
    10_000
  )
}

/**
 * 滑动。
 *
 * `input swipe` 的最后一个参数是滑动耗时，越快越接近「甩」的手感。
 */
export async function swipe(deviceId: string, action: SwipeAction): Promise<void> {
  const duration = Math.round(clamp(action.durationMs, 50, 2_000))
  await adbRunOn(
    deviceId,
    [
      'shell',
      'input',
      'swipe',
      String(Math.round(action.from.x)),
      String(Math.round(action.from.y)),
      String(Math.round(action.to.x)),
      String(Math.round(action.to.y)),
      String(duration)
    ],
    duration + 10_000
  )
}

/** 常用按键码 */
export const KeyCode = {
  /** 返回 */
  BACK: 4,
  /** 返回桌面 */
  HOME: 3,
  /** 最近任务 */
  APP_SWITCH: 187,
  /** 音量减 */
  VOLUME_DOWN: 25,
  /** 音量加 */
  VOLUME_UP: 24,
  /** 电源键 */
  POWER: 26
} as const

export type KeyCodeValue = (typeof KeyCode)[keyof typeof KeyCode]

/** 发送按键事件 */
export async function keyEvent(deviceId: string, keyCode: KeyCodeValue): Promise<void> {
  await adbRunOn(deviceId, ['shell', 'input', 'keyevent', String(keyCode)], 10_000)
}
