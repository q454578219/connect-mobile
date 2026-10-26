import type { EditKey } from '@shared/types'
import { adbRunOn } from './adb'
import { escapeForShell, isAsciiText } from './text-input'

export { isAsciiText }

/** 编辑键到 Android keyevent 码的映射 */
const EDIT_KEY_CODES: Record<EditKey, number> = {
  enter: 66,
  backspace: 67,
  delete: 112,
  tab: 61,
  escape: 111,
  space: 62,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  home: 122,
  end: 123
}

/**
 * 输入一段 ASCII 文本。
 *
 * 调用方需先用 isAsciiText 判断；非 ASCII 文本会抛错，避免静默丢字。
 */
export async function sendText(deviceId: string, text: string): Promise<void> {
  if (!text) return
  if (!isAsciiText(text)) {
    throw new Error('input text 不支持中文等非 ASCII 字符')
  }
  await adbRunOn(deviceId, ['shell', 'input', 'text', escapeForShell(text)], 15_000)
}

/** 发送编辑按键（回车、退格、方向键等） */
export async function sendEditKey(deviceId: string, key: EditKey): Promise<void> {
  const code = EDIT_KEY_CODES[key]
  if (code === undefined) throw new Error(`不支持的编辑键：${key}`)
  await adbRunOn(deviceId, ['shell', 'input', 'keyevent', String(code)], 10_000)
}
