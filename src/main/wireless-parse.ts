/**
 * 无线连接相关的纯解析逻辑，与 adb 解耦便于单测。
 *
 * adb 的输出格式在不同版本间有差异（mdns 列数、pair 的提示语都不固定），
 * 所以这里统一做宽容解析：能找到 IP:端口就认，找不到就返回空。
 */
import type { MdnsService } from '@shared/types'

/** 无线设备的 adb 序列号形如 192.168.31.23:5555 */
const WIRELESS_ID_RE = /^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/

export function isWirelessId(id: string): boolean {
  return WIRELESS_ID_RE.test(id)
}

/**
 * 解析 `adb mdns services` 输出。
 *
 * 典型输出（制表符分隔，也可能变成空格）：
 *   There are 2 services:
 *   \tabd-30E6XXXX-xxxx._adb-tls-connect._tcp.\t192.168.31.23:37913
 *   \tabd-30E6XXXX-xxxx._adb-tls-pairing._tcp.\t192.168.31.23:41235
 *
 * _adb-tls-connect 是可以直接 connect 的服务；_adb-tls-pairing 是配对服务
 * （端口语义不同，必须先 pair 才能连）。按 kind + ip + port 去重。
 */
export function parseMdnsServices(raw: string): MdnsService[] {
  const seen = new Set<string>()
  const services: MdnsService[] = []
  for (const line of raw.split(/\r?\n/)) {
    const kind = line.includes('_adb-tls-pairing')
      ? 'pair'
      : line.includes('_adb-tls-connect')
        ? 'connect'
        : null
    if (!kind) continue
    const match = /(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})/.exec(line)
    if (!match) continue
    const ip = match[1]
    const port = Number(match[2])
    const key = `${kind}|${ip}|${port}`
    if (seen.has(key)) continue
    seen.add(key)
    services.push({ ip, port, kind })
  }
  return services
}

/**
 * 从 `ip addr show wlan0`（或 `ip route`）输出里提取手机的 WiFi IPv4。
 *
 * addr 格式：inet 192.168.31.23/24 brd ... scope global wlan0
 * route 格式：192.168.31.0/24 dev wlan0 ... src 192.168.31.23
 * 跳过 127.0.0.1 回环。
 */
export function parseWlanIp(addrOut: string, routeOut = ''): string | null {
  const fromAddr = /inet\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+/.exec(addrOut)
  if (fromAddr && !fromAddr[1].startsWith('127.')) return fromAddr[1]
  const fromRoute = /src\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(routeOut)
  if (fromRoute && !fromRoute[1].startsWith('127.')) return fromRoute[1]
  return null
}

/** 判定 `adb connect` 的输出：失败时给出可读原因 */
export function interpretConnectOutput(text: string): { ok: boolean; message: string } {
  if (/already connected|connected to/i.test(text)) {
    return { ok: true, message: text.trim() }
  }
  if (/failed|cannot|unable|timed? ?out|refused/i.test(text)) {
    return {
      ok: false,
      message:
        '连接失败：请确认手机「无线调试」已开启、IP 和端口与手机上显示的一致，且手机与电脑在同一网络。' +
        (text.trim() ? `（adb: ${text.trim()}）` : '')
    }
  }
  return { ok: false, message: text.trim() || '连接失败：adb 没有返回结果，请重试' }
}

/** 判定 `adb pair` 的输出 */
export function interpretPairOutput(text: string): { ok: boolean; message: string } {
  if (/success/i.test(text)) {
    return { ok: true, message: text.trim() }
  }
  if (/fail|error|invalid|expired|timed? ?out/i.test(text)) {
    return {
      ok: false,
      message:
        '配对失败：配对码或配对端口可能输错了（配对端口和连接端口是两个不同的端口），' +
        '配对弹窗 1 分钟后会过期，请重新获取。' +
        (text.trim() ? `（adb: ${text.trim()}）` : '')
    }
  }
  return { ok: false, message: text.trim() || '配对失败：adb 没有返回结果，请重试' }
}
