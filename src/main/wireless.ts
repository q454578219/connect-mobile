/**
 * WiFi 无线连接（ADB over TCP/IP）。
 *
 * Android 11+：手机「开发者选项 → 无线调试」里可看 IP:端口与配对码，
 * 配对一次后长期可连；`adb mdns services` 还能自动发现局域网内的设备。
 *
 * Android 10 及以下没有配对协议：需要先插一次 USB，用 `adb tcpip 5555`
 * 切到 TCP 模式再连，之后拔线无线使用（重启手机后要重来）。
 */
import { adbExec, adbRun, adbRunOn } from './adb'
import {
  interpretConnectOutput,
  interpretPairOutput,
  parseMdnsServices,
  parseWlanIp
} from './wireless-parse'

/** adb 无线调试的默认 TCP 端口（tcpip 模式） */
const DEFAULT_TCP_PORT = 5555

/** 局域网 mDNS 扫描，返回可直接连接/需要配对的服务列表 */
export async function scanServices(): Promise<{ services: ReturnType<typeof parseMdnsServices>; supported: boolean }> {
  // adb mdns 需要较新版本 adb；不支持时静默降级为手动输入
  try {
    const check = await adbExec(['mdns', 'check'], 8_000)
    if (!/ok/i.test(check.stdout)) return { services: [], supported: false }
  } catch {
    return { services: [], supported: false }
  }
  try {
    const { stdout } = await adbExec(['mdns', 'services'], 8_000)
    return { services: parseMdnsServices(stdout), supported: true }
  } catch {
    return { services: [], supported: false }
  }
}

/** 用配对码配对（Android 11+ 的无线调试弹窗） */
export async function pair(ip: string, port: number, code: string): Promise<void> {
  const { stdout, stderr } = await adbExec(['pair', `${ip}:${port}`, code], 15_000)
  const text = `${stdout}\n${stderr}`
  const result = interpretPairOutput(text)
  if (!result.ok) throw new Error(result.message)
}

/** 连接一台无线设备（端口是无线调试显示的端口，不是配对端口） */
export async function connect(ip: string, port: number): Promise<string> {
  const { stdout, stderr } = await adbExec(['connect', `${ip}:${port}`], 15_000)
  const text = `${stdout}\n${stderr}`
  const result = interpretConnectOutput(text)
  if (!result.ok) throw new Error(result.message)
  return `${ip}:${port}`
}

/** 断开一台无线设备 */
export async function disconnect(ip: string, port: number): Promise<void> {
  await adbRun(['disconnect', `${ip}:${port}`], 8_000).catch(() => {})
}

/**
 * USB 一键转无线（Android 10 及以下）：
 * `tcpip 5555` → 读 wlan0 IP → connect。
 * 返回连接成功后的设备序列号（IP:5555）。
 */
export async function bridgeFromUsb(usbId: string): Promise<string> {
  await adbRunOn(usbId, ['tcpip', String(DEFAULT_TCP_PORT)], 10_000)

  const addrOut = await adbRunOn(usbId, ['shell', 'ip', 'addr', 'show', 'wlan0'], 8_000).catch(() => '')
  const routeOut = addrOut ? '' : await adbRunOn(usbId, ['shell', 'ip', 'route'], 8_000).catch(() => '')
  const ip = parseWlanIp(addrOut, routeOut)
  if (!ip) {
    throw new Error('读取手机 WiFi IP 失败：请确认手机已连接 WiFi（不是仅开热点），再重试')
  }
  return connect(ip, DEFAULT_TCP_PORT)
}
