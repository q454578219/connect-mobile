/**
 * 屏幕坐标换算。
 *
 * 单独成模块是为了让这块纯计算逻辑能被单测直接覆盖，不必拉起 adb 或 Electron。
 */

export interface Point {
  x: number
  y: number
}

export interface ScreenSize {
  width: number
  height: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 画面坐标到设备坐标的缩放比例。
 *
 * 投屏画面通常是按 targetWidth 缩小过的（设备 1440 宽、画面只有 720 宽），
 * 所以必须放大回去，否则点击会整体落到屏幕左上角。
 */
export function scaleFor(
  frame: ScreenSize,
  screen: ScreenSize,
  rotated: boolean
): { scaleX: number; scaleY: number } {
  const displayW = rotated ? screen.height : screen.width
  const displayH = rotated ? screen.width : screen.height
  return {
    scaleX: frame.width > 0 ? displayW / frame.width : 1,
    scaleY: frame.height > 0 ? displayH / frame.height : 1
  }
}

/**
 * 把画面坐标换算成设备屏幕坐标。
 *
 * @param point    画布上的坐标（画面像素）
 * @param frame    画面尺寸（解码出来的宽高）
 * @param screen   设备屏幕尺寸（竖屏基准）
 * @param rotated  是否横屏
 */
export function toDevicePoint(
  point: Point,
  frame: ScreenSize,
  screen: ScreenSize,
  rotated: boolean
): Point {
  const displayW = rotated ? screen.height : screen.width
  const displayH = rotated ? screen.width : screen.height
  const { scaleX, scaleY } = scaleFor(frame, screen, rotated)

  return {
    // 上界用 display-1：Android 的 input 命令把坐标视为像素点，等于宽度会落到屏幕外
    x: Math.round(clamp(point.x * scaleX, 0, displayW - 1)),
    y: Math.round(clamp(point.y * scaleY, 0, displayH - 1))
  }
}
