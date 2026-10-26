import { useCallback, useEffect, useState } from 'react'
import type { DeviceInfo, MdnsService } from '@shared/types'

interface WirelessDialogProps {
  open: boolean
  devices: DeviceInfo[]
  onClose(): void
  /** 连接成功后回调（参数是连接上的设备 id），用于自动选中新设备 */
  onConnected(deviceId: string): void
}

type Feedback = { kind: 'info' | 'ok' | 'error'; text: string } | null

const LS_KEY = 'wireless.last-target'

/**
 * 无线连接弹窗。
 *
 * 覆盖两条路径：
 * - Android 11+：手机开「无线调试」→ 这里扫描（或手输 IP:端口）→ 有配对服务时先配对再连
 * - Android 10-：先插 USB，用下方「USB 转无线」一键切换，之后拔线无线用
 */
export function WirelessDialog({ open, devices, onClose, onConnected }: WirelessDialogProps) {
  const [scanning, setScanning] = useState(false)
  const [scanSupported, setScanSupported] = useState(true)
  const [services, setServices] = useState<MdnsService[]>([])
  const [ip, setIp] = useState('')
  const [port, setPort] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [pairTarget, setPairTarget] = useState('')
  const [pairPort, setPairPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)

  // 上次手输的目标记下来，下次默认带出
  useEffect(() => {
    if (!open) return
    const saved = localStorage.getItem(LS_KEY)
    if (saved) {
      const [savedIp, savedPort] = saved.split(':')
      if (savedIp) setIp(savedIp)
      if (savedPort) setPort(savedPort)
    }
  }, [open])

  const scan = useCallback(async () => {
    setScanning(true)
    setFeedback(null)
    try {
      const result = await window.desktop.wirelessScan()
      setScanSupported(result.supported)
      setServices(result.services)
      if (!result.supported) {
        setFeedback({ kind: 'info', text: '当前 adb 版本不支持 mDNS 扫描，请手动输入 IP 和端口' })
      } else if (result.services.length === 0) {
        setFeedback({
          kind: 'info',
          text: '没扫到设备：请确认手机「无线调试」已开启；Windows 防火墙也可能拦截 mDNS，此时可手动输入 IP:端口'
        })
      }
    } catch (err) {
      setFeedback({ kind: 'error', text: String((err as Error).message ?? err) })
    } finally {
      setScanning(false)
    }
  }, [])

  const doConnect = useCallback(
    async (targetIp: string, targetPort: number) => {
      setBusy(true)
      setFeedback({ kind: 'info', text: `正在连接 ${targetIp}:${targetPort}…` })
      try {
        const id = await window.desktop.wirelessConnect(targetIp, targetPort)
        localStorage.setItem(LS_KEY, `${targetIp}:${targetPort}`)
        setFeedback({ kind: 'ok', text: `已连接 ${id}，现在可以在设备列表里选中它开始投屏` })
        onConnected(id)
      } catch (err) {
        setFeedback({ kind: 'error', text: (err as Error).message })
      } finally {
        setBusy(false)
      }
    },
    [onConnected]
  )

  const doPair = useCallback(async () => {
    const targetPort = Number(pairPort)
    if (!pairTarget || !Number.isFinite(targetPort) || targetPort <= 0) {
      setFeedback({ kind: 'error', text: '请填写配对弹窗里显示的「IP 地址和端口」' })
      return
    }
    if (!/^\d{6}$/.test(pairCode.trim())) {
      setFeedback({ kind: 'error', text: '配对码是 6 位数字' })
      return
    }
    setBusy(true)
    setFeedback({ kind: 'info', text: '正在配对…' })
    try {
      await window.desktop.wirelessPair(pairTarget, targetPort, pairCode.trim())
      setFeedback({ kind: 'ok', text: '配对成功！用「无线调试」主页面上显示的 IP 和端口连接' })
    } catch (err) {
      setFeedback({ kind: 'error', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }, [pairTarget, pairPort, pairCode])

  const doUsbBridge = useCallback(
    async (deviceId: string) => {
      setBusy(true)
      setFeedback({ kind: 'info', text: '正在把 USB 连接切换为无线（tcpip 5555）…' })
      try {
        const id = await window.desktop.wirelessFromUsb(deviceId)
        setFeedback({ kind: 'ok', text: `无线连接已建立（${id}），现在可以拔掉 USB 线了` })
        onConnected(id)
      } catch (err) {
        setFeedback({ kind: 'error', text: (err as Error).message })
      } finally {
        setBusy(false)
      }
    },
    [onConnected]
  )

  if (!open) return null

  const usbDevices = devices.filter((d) => !d.wireless && d.state === 'device')
  const connectServices = services.filter((s) => s.kind === 'connect')
  const pairServices = services.filter((s) => s.kind === 'pair')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-[560px] flex-col overflow-y-auto rounded-lg border border-white/10 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">无线连接</h2>
          <button className="text-slate-400 hover:text-slate-200" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="space-y-5 px-4 py-4 text-sm">
          {/* 扫描 */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-slate-300">
                1. 扫描局域网设备（Android 11+）
              </h3>
              <button
                className="rounded bg-sky-600 px-2 py-1 text-[11px] text-white hover:bg-sky-500 disabled:opacity-40"
                disabled={scanning || busy}
                onClick={() => void scan()}
              >
                {scanning ? '扫描中…' : '扫描'}
              </button>
            </div>
            {connectServices.length > 0 && (
              <ul className="divide-y divide-white/5 rounded border border-white/10">
                {connectServices.map((s) => (
                  <li key={`${s.ip}:${s.port}`} className="flex items-center justify-between px-3 py-2">
                    <span className="font-mono text-xs text-slate-200">
                      {s.ip}:{s.port}
                    </span>
                    <button
                      className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] text-white hover:bg-emerald-500 disabled:opacity-40"
                      disabled={busy}
                      onClick={() => void doConnect(s.ip, s.port)}
                    >
                      连接
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {pairServices.length > 0 && (
              <p className="text-[11px] leading-relaxed text-amber-300">
                发现配对服务（{pairServices.map((s) => `${s.ip}:${s.port}`).join('、')}）。首次使用请在手机
                「无线调试 → 使用配对码配对设备」里拿到配对码，填到下方第 2 步完成配对。
              </p>
            )}
            {services.length === 0 && (
              <p className="text-[11px] leading-relaxed text-slate-500">
                手机：开发者选项 → 无线调试 → 开启。扫描不到时直接手输第 3 步的 IP 和端口。
              </p>
            )}
          </section>

          {/* 配对 */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-slate-300">2. 配对码配对（首次使用需要一次）</h3>
            <div className="flex gap-2">
              <input
                className="w-44 rounded bg-white/10 px-2 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-500"
                placeholder="配对 IP 如 192.168.1.8"
                value={pairTarget}
                onChange={(e) => setPairTarget(e.target.value.trim())}
              />
              <input
                className="w-20 rounded bg-white/10 px-2 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-500"
                placeholder="端口"
                value={pairPort}
                onChange={(e) => setPairPort(e.target.value.replace(/\D/g, ''))}
              />
              <input
                className="w-20 rounded bg-white/10 px-2 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-500"
                placeholder="配对码"
                maxLength={6}
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value.replace(/\D/g, ''))}
              />
              <button
                className="rounded bg-sky-600 px-2 py-1 text-[11px] text-white hover:bg-sky-500 disabled:opacity-40"
                disabled={busy}
                onClick={() => void doPair()}
              >
                配对
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              三项都来自手机「使用配对码配对设备」弹窗；注意配对端口和连接端口是两个不同的端口，弹窗 1
              分钟内有效。
            </p>
          </section>

          {/* 手动连接 */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-slate-300">3. 手动连接</h3>
            <div className="flex gap-2">
              <input
                className="w-44 rounded bg-white/10 px-2 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-500"
                placeholder="IP 如 192.168.1.8"
                value={ip}
                onChange={(e) => setIp(e.target.value.trim())}
              />
              <input
                className="w-20 rounded bg-white/10 px-2 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-500"
                placeholder="端口"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              />
              <button
                className="rounded bg-emerald-600 px-2 py-1 text-[11px] text-white hover:bg-emerald-500 disabled:opacity-40"
                disabled={busy || !ip || !port}
                onClick={() => void doConnect(ip, Number(port))}
              >
                连接
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              端口在手机「无线调试」主页显示（每次开启会变）。
            </p>
          </section>

          {/* USB 转无线 */}
          {usbDevices.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-slate-300">USB 转无线（Android 10 及以下）</h3>
              <div className="flex flex-wrap gap-2">
                {usbDevices.map((d) => (
                  <button
                    key={d.id}
                    className="rounded bg-white/10 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/20 disabled:opacity-40"
                    disabled={busy}
                    onClick={() => void doUsbBridge(d.id)}
                  >
                    {d.model ?? d.id} → 无线
                  </button>
                ))}
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                老系统没有配对协议：保持 USB 连接和 WiFi 在线，点一下切换，成功后拔线即可。
              </p>
            </section>
          )}

          {!scanSupported && (
            <p className="text-[11px] text-amber-300">
              注意：当前 adb 不支持 mDNS 扫描（或被防火墙拦截），请使用手动连接。
            </p>
          )}

          {feedback && (
            <p
              className={`rounded px-2 py-1.5 text-[11px] leading-relaxed ${
                feedback.kind === 'error'
                  ? 'bg-rose-950/60 text-rose-200'
                  : feedback.kind === 'ok'
                    ? 'bg-emerald-950/60 text-emerald-200'
                    : 'bg-sky-950/60 text-sky-200'
              }`}
            >
              {feedback.text}
            </p>
          )}

          <p className="border-t border-white/10 pt-3 text-[11px] leading-relaxed text-slate-500">
            无线模式的画质流畅度受 WiFi 带宽影响，建议投屏宽度选 720 或更低；延迟也会比 USB 稍高。
          </p>
        </div>
      </div>
    </div>
  )
}
