/**
 * 息屏投屏（等效方案）。
 *
 * 真正的「关掉屏幕仍在录」需要往手机推 scrcpy 式的服务进程，与本应用
 * 「零设备端依赖」的架构冲突。这里采用免部署的等效做法：
 *
 *   1. 先关闭自动亮度（screen_brightness_mode 0）——顺序很重要，
 *      否则 ROM 会立刻用环境光把亮度顶回去，表现为「开了没反应」
 *   2. 亮度写到 0：多数 ROM 上 0 = 背光直接关闭，系统仍在正常渲染与编码；
 *      会把 0 钳到最小值的 ROM 也能拿到最低亮度
 *   3. 新系统（部分 ROM）亮度走 screen_brightness_float，双写兜底
 *   4. 临时把「自动锁屏」超时拉长（30 分钟），防止投屏中途熄屏断流
 *
 * 代价：屏幕背光可能并未真正关闭（取决于 ROM），省电有限；
 * 优点：screenrecord 不会断帧，退出投屏时把原始值还原。
 */
import { adbRunOn } from './adb'

/** 临时锁屏超时：30 分钟 */
const EXTENDED_TIMEOUT_MS = 30 * 60 * 1000

/** 一台设备正在生效的息屏投屏状态（用于停止时还原） */
interface ScreenPowerState {
  brightness: string | null
  brightnessFloat: string | null
  autoMode: string | null
  timeout: string | null
}

const states = new Map<string, ScreenPowerState>()

/** 读 system 设置；键不存在或读取失败返回 null（还原时跳过即可） */
async function getSetting(deviceId: string, key: string): Promise<string | null> {
  try {
    const out = await adbRunOn(deviceId, ['shell', 'settings', 'get', 'system', key], 8_000)
    const value = out.trim()
    return value && value !== 'null' && value !== '' ? value : null
  } catch {
    return null
  }
}

async function putSetting(deviceId: string, key: string, value: string): Promise<void> {
  await adbRunOn(deviceId, ['shell', 'settings', 'put', 'system', key, value], 8_000).catch(() => {})
}

/** 开启息屏投屏：备份原值 → 关自动亮度 → 亮度压到最低 → 延长锁屏 */
export async function enableScreenPower(deviceId: string): Promise<void> {
  if (states.has(deviceId)) return
  const [brightness, brightnessFloat, autoMode, timeout] = await Promise.all([
    getSetting(deviceId, 'screen_brightness'),
    getSetting(deviceId, 'screen_brightness_float'),
    getSetting(deviceId, 'screen_brightness_mode'),
    getSetting(deviceId, 'screen_off_timeout')
  ])
  states.set(deviceId, { brightness, brightnessFloat, autoMode, timeout })

  // 先关自动亮度，再压亮度，顺序不能反
  if (autoMode !== null) await putSetting(deviceId, 'screen_brightness_mode', '0')
  await putSetting(deviceId, 'screen_brightness', '0')
  await putSetting(deviceId, 'screen_brightness_float', '0.0')
  await putSetting(deviceId, 'screen_off_timeout', String(EXTENDED_TIMEOUT_MS))
}

/** 还原亮度、自动亮度与锁屏超时（幂等：没有记录就什么都不做） */
export async function restoreScreenPower(deviceId: string): Promise<void> {
  const state = states.get(deviceId)
  if (!state) return
  states.delete(deviceId)
  if (state.brightness !== null) {
    await putSetting(deviceId, 'screen_brightness', state.brightness)
  }
  if (state.brightnessFloat !== null) {
    await putSetting(deviceId, 'screen_brightness_float', state.brightnessFloat)
  }
  if (state.autoMode !== null) {
    await putSetting(deviceId, 'screen_brightness_mode', state.autoMode)
  }
  if (state.timeout !== null) {
    await putSetting(deviceId, 'screen_off_timeout', state.timeout)
  }
}
