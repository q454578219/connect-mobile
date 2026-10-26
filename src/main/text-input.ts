/**
 * 文本输入相关的纯逻辑。
 *
 * 单独成模块是为了能被单元测试直接覆盖，不必加载 adb 相关代码。
 */

/**
 * 判断文本能否用 `input text` 发送。
 *
 * Android 的 `input text` 只能处理 ASCII 可打印字符（0x20~0x7E）。
 * 实测（Redmi K70 Pro / Android 16）：传入中文会让设备端
 * InputShellCommand 抛 NullPointerException 直接失败，
 * 所以必须提前判断，不能指望它自动忽略不支持的字符。
 */
export function isAsciiText(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(text)
}

/**
 * 把文本转义成可以安全传给 `adb shell input text` 的形式。
 *
 * 两个层次都要处理：
 * 1. 设备端 shell：空格、引号、$、&、| 这些元字符会被 sh 解析，必须转义
 * 2. input text 自身：空格要写成 %s
 */
export function escapeForShell(text: string): string {
  return text
    .replace(/ /g, '%s')
    .replace(/(["'`$\\])/g, '\\$1')
    .replace(/([&|;<>()*?[\]{}!#~^])/g, '\\$1')
}
