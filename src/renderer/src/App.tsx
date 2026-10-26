import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CaptureMode,
  DeviceInfo,
  NavKey,
  StreamStats,
  StreamStatus,
  VideoPacket
} from '@shared/types'
import { DeviceCanvas, type DeviceCanvasHandle } from './components/DeviceCanvas'
import { KeyboardInput } from './components/KeyboardInput'
import { WirelessDialog } from './components/WirelessDialog'
import { ColorMaskButton, ColorMaskOverlay, DEFAULT_MASK, type MaskConfig } from './components/ColorMask'
import { useH264Player } from './hooks/useH264Player'

/** 画面下方工具条的导航键 */
const NAV_KEYS: { key: NavKey; label: string; title: string }[] = [
  { key: 'back', label: '◀', title: '返回' },
  { key: 'home', label: '⌂', title: '桌面' },
  { key: 'appSwitch', label: '▣', title: '最近任务' },
  { key: 'volumeUp', label: '🔊', title: '音量加' },
  { key: 'volumeDown', label: '🔉', title: '音量减' },
  { key: 'power', label: '⏻', title: '电源键' }
]/** 侧栏宽度范围与持久化键 */
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 480
const LS_SIDEBAR_WIDTH = 'ui.sidebarWidth'
const LS_SIDEBAR_COLLAPSED = 'ui.sidebarCollapsed'
const LS_STRETCH = 'ui.stretch'
const LS_PREFER_FPS = 'ui.preferFps'
const LS_MASK = 'ui.mask'
const LS_COMPACT = 'ui.compactOnCollapse'

/** 一次整屏滑动手势的幅度（占画面尺寸比例），按钮与热键共用 */
const SWIPE_SPAN = 0.32

/**
 * 四向滑动按钮与热键共用的一组手势。
 * 热键布局与屏幕方向一致：小键盘 1/2/3/4（顶排数字也可）= 左/右/上/下滑。
 */
const SWIPE_ACTIONS: {
  key: string
  label: string
  title: string
  hotkey: string[]
  gesture(width: number, height: number): { from: { x: number; y: number }; to: { x: number; y: number } }
}[] = [
  {
    key: 'swipeLeft',
    label: '⬅',
    title: '左滑（热键 1）',
    hotkey: ['1', 'End'],
    gesture: (w, h) => ({ from: { x: w * 0.38, y: h / 2 }, to: { x: w * 0.38 + w * SWIPE_SPAN, y: h / 2 } })
  },
  {
    key: 'swipeRight',
    label: '➡',
    title: '右滑（热键 2）',
    hotkey: ['2', 'ArrowDown'],
    gesture: (w, h) => ({ from: { x: w * 0.62, y: h / 2 }, to: { x: w * 0.62 - w * SWIPE_SPAN, y: h / 2 } })
  },
  {
    key: 'swipeUp',
    label: '⬆',
    title: '上滑（热键 3）',
    hotkey: ['3', 'PageDown'],
    gesture: (w, h) => ({ from: { x: w / 2, y: h * 0.62 }, to: { x: w / 2, y: h * 0.62 - h * SWIPE_SPAN } })
  },
  {
    key: 'swipeDown',
    label: '⬇',
    title: '下滑（热键 4）',
    hotkey: ['4', 'PageUp'],
    gesture: (w, h) => ({ from: { x: w / 2, y: h * 0.38 }, to: { x: w / 2, y: h * 0.38 + h * SWIPE_SPAN } })
  }
]

export function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<StreamStatus>('stopped')
  const [statusMessage, setStatusMessage] = useState<string | undefined>()
  const [mode, setMode] = useState<CaptureMode | undefined>()
  const [, setStats] = useState<StreamStats>({ frames: 0, fps: 0, width: 0, height: 0 })
  const [targetWidth, setTargetWidth] = useState(720)
  const [ready, setReady] = useState(false)

  // 侧栏：宽度可拖拽、可整体收起，状态记到 localStorage
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(LS_SIDEBAR_WIDTH))
    return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : 260
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(LS_SIDEBAR_COLLAPSED) === '1'
  )
  const draggingRef = useRef(false)

  // 息屏投屏开关；会话停止后由主进程自动还原，这里只同步 UI 状态
  const [screenPower, setScreenPower] = useState(false)
  const [wirelessOpen, setWirelessOpen] = useState(false)

  // 画面拉伸铺满：忽略手机宽高比强制铺满窗口，坐标换算不受影响
  const [stretch, setStretch] = useState(() => localStorage.getItem(LS_STRETCH) === '1')

  // 流畅优先：采集端提高码率（minicap 路径还提高帧率），减少高分辨率下的设备端丢帧
  const [preferFps, setPreferFps] = useState(() => localStorage.getItem(LS_PREFER_FPS) === '1')

  // 打字捕获状态存 ref：热键监听不重挂，回调里读最新值
  const capturingRef = useRef(false)
  const handleCapturingChange = useCallback((v: boolean) => {
    capturingRef.current = v
  }, [])

  // 画面遮罩（黑夜/护眼/自定义色调 + 压暗），配置持久化
  const [mask, setMask] = useState<MaskConfig>(() => {
    try {
      const saved = localStorage.getItem(LS_MASK)
      return saved ? { ...DEFAULT_MASK, ...(JSON.parse(saved) as MaskConfig) } : DEFAULT_MASK
    } catch {
      return DEFAULT_MASK
    }
  })
  const handleMaskChange = useCallback((config: MaskConfig) => {
    setMask(config)
    localStorage.setItem(LS_MASK, JSON.stringify(config))
  }, [])

  const toggleStretch = useCallback(() => {
    setStretch((v) => {
      localStorage.setItem(LS_STRETCH, v ? '0' : '1')
      return !v
    })
  }, [])

  const canvasRef = useRef<DeviceCanvasHandle | null>(null)
  /** 旧设备走 minicap 时是 JPEG 帧，用 <img> 解码后画到画布 */
  const jpegUrlRef = useRef<string | null>(null)
  /** 是否已经画出第一帧（用 ref 避免闭包里读到旧值） */
  const readyRef = useRef(false)
  /** 当前采集方式，事件回调里要读最新值 */
  const modeRef = useRef<CaptureMode | undefined>(undefined)
  modeRef.current = mode

  const handleDecodedFrame = useCallback((frame: VideoFrame) => {
    canvasRef.current?.draw(frame, frame.displayWidth, frame.displayHeight)
    if (!readyRef.current) {
      readyRef.current = true
      setReady(true)
    }
  }, [])

  const { state: player, configure, append, reset } = useH264Player({ onFrame: handleDecodedFrame })

  // 画面原始尺寸：优先用解码器报的，回退到设备信息
  const frameWidth = player.width || devices.find((d) => d.id === selectedId)?.screen?.width || 1080
  const frameHeight = player.height || devices.find((d) => d.id === selectedId)?.screen?.height || 2400

  useEffect(() => {
    const off = window.desktop.onEvent((event) => {
      if (event.type === 'devices-changed') {
        setDevices(event.devices)
        setSelectedId((prev) => {
          if (prev && event.devices.some((d) => d.id === prev && d.state === 'device')) return prev
          return event.devices.find((d) => d.state === 'device')?.id ?? null
        })
      } else if (event.type === 'stream-status') {
        setStatus(event.status)
        setStatusMessage(event.message)
        if (event.mode) setMode(event.mode)
        if (event.status === 'stopped' || event.status === 'error') {
          readyRef.current = false
          setReady(false)
          setScreenPower(false)
        }
      } else if (event.type === 'stream-stats') {
        setStats(event.stats)
      } else if (event.type === 'decoder-config') {
        configure(event.config)
      } else if (event.type === 'video-packet') {
        handlePacket(event.packet)
      }
    })

    /** H.264 帧交给解码器；JPEG 帧（minicap 回退）直接当图片画 */
    function handlePacket(packet: VideoPacket) {
      if (modeRef.current === 'minicap') {
        drawJpeg(packet.data)
        return
      }
      append(packet)
    }

    function drawJpeg(bytes: Uint8Array) {
      if (jpegUrlRef.current) URL.revokeObjectURL(jpegUrlRef.current)
      // IPC 结构化克隆过来的 buffer 一定是普通 ArrayBuffer（不会是 SharedArrayBuffer）
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' }))
      jpegUrlRef.current = url
      const img = new Image()
      img.onload = () => {
        canvasRef.current?.draw(img, img.naturalWidth, img.naturalHeight)
        if (!readyRef.current) {
          readyRef.current = true
          setReady(true)
        }
      }
      img.src = url
    }

    return off
  }, [append, configure])

  useEffect(() => {
    void window.desktop.listDevices().then((list) => {
      setDevices(list)
      setSelectedId(list.find((d) => d.state === 'device')?.id ?? null)
    })
  }, [])

  // 侧栏拖拽调宽：按下后全局监听移动/抬起
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX))
      setSidebarWidth(width)
    }
    const onUp = () => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setSidebarWidth((w) => {
        localStorage.setItem(LS_SIDEBAR_WIDTH, String(w))
        return w
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      localStorage.setItem(LS_SIDEBAR_COLLAPSED, v ? '0' : '1')
      return !v
    })
  }, [])

  // 收起侧栏时顺带把窗口缩成贴合画面的小窗（scrcpy 风格），展开时恢复大窗。
  // 只有投屏中（画面已出）才有意义；ratio = 画面宽/高。
  const [compactOnCollapse, setCompactOnCollapse] = useState(
    () => localStorage.getItem(LS_COMPACT) !== '0'
  )
  const toggleCompactOnCollapse = useCallback(() => {
    setCompactOnCollapse((v) => {
      localStorage.setItem(LS_COMPACT, v ? '0' : '1')
      return !v
    })
  }, [])

  // 紧凑模式：窗口宽度不够时，带字的按钮自动只留图标
  const [compactUi, setCompactUi] = useState(false)
  useEffect(() => {
    const check = (): void => setCompactUi(window.innerWidth < 760)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    if (!compactOnCollapse || !ready) return
    // 高为 0 或异常时不动作；ratio<1 竖屏按高 720 算，>=1 横屏按宽 900 算
    if (frameWidth <= 0 || frameHeight <= 0) return
    void window.desktop.compactWindow(sidebarCollapsed ? frameWidth / frameHeight : null)
    // ready 变化（投屏开始/结束）和收起状态都要响应
  }, [sidebarCollapsed, compactOnCollapse, ready, frameWidth, frameHeight])

  const selected = devices.find((d) => d.id === selectedId)
  const canControl = status === 'streaming' && selected?.state === 'device'

  const handleStart = useCallback(async () => {
    if (!selectedId) return
    reset()
    readyRef.current = false
    setReady(false)
    setMode(undefined)
    await window.desktop.startStream(selectedId, targetWidth, preferFps)
  }, [selectedId, targetWidth, preferFps, reset])

  const handleStop = useCallback(async () => {
    await window.desktop.stopStream()
    reset()
    readyRef.current = false
    setReady(false)
  }, [reset])

  const handleTap = useCallback(
    (point: { x: number; y: number }) => {
      if (!selectedId || !canControl) return
      void window.desktop.tap(selectedId, point).catch((err) => {
        console.error('点击失败', err)
        setStatusMessage(String(err))
      })
    },
    [selectedId, canControl]
  )

  const handleSwipe = useCallback(
    (action: { from: { x: number; y: number }; to: { x: number; y: number }; durationMs: number }) => {
      if (!selectedId || !canControl) return
      void window.desktop.swipe(selectedId, action).catch((err) => {
        console.error('滑动失败', err)
        setStatusMessage(String(err))
      })
    },
    [selectedId, canControl]
  )

  const handlePressKey = useCallback(
    (key: NavKey) => {
      if (!selectedId || !canControl) return
      void window.desktop.pressKey(selectedId, key).catch((err) => {
        console.error('按键失败', err)
        setStatusMessage(String(err))
      })
    },
    [selectedId, canControl]
  )

  /** 触发一次四向滑动（按钮与热键共用） */
  const triggerSwipeAction = useCallback(
    (key: string) => {
      if (!selectedId || !canControl) return
      const action = SWIPE_ACTIONS.find((a) => a.key === key)
      if (!action) return
      void handleSwipe({ ...action.gesture(frameWidth, frameHeight), durationMs: 180 })
    },
    [selectedId, canControl, handleSwipe, frameWidth, frameHeight]
  )

  // 手势热键：数字键盘/顶排 1/2/3/4 = 左/右/上/下滑。
  // 打字捕获中或焦点在输入框时不拦截，数字正常输入。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!canControl || capturingRef.current) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      // Numpad1-4 与顶排 '1'-'4' 都认；Numpad 的 e.key 是 '1' 但 code 是 'Numpad1'
      const action = SWIPE_ACTIONS.find(
        (a) => a.hotkey.includes(e.key) && (e.code.startsWith('Numpad') || /^[1-4]$/.test(e.key))
      )
      if (action) {
        e.preventDefault()
        triggerSwipeAction(action.key)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canControl, triggerSwipeAction])

  const toggleScreenPower = useCallback(async () => {
    if (!selectedId || !canControl) return
    const next = !screenPower
    setScreenPower(next)
    try {
      await window.desktop.setScreenPower(selectedId, next)
    } catch (err) {
      setScreenPower(!next)
      setStatusMessage(String((err as Error).message ?? err))
    }
  }, [selectedId, canControl, screenPower])

  return (
    <div
      className="flex h-full flex-col"
      // 整窗遮罩模式下，把界面底色也调成遮罩色调，侧栏/菜单栏不再是死的深黑色
      style={
        mask.mode !== 'off' && mask.scope === 'window'
          ? { background: mask.mode === 'night' ? '#3d2b18' : mask.color, transition: 'background 200ms' }
          : undefined
      }
    >
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <button
          className="rounded px-2 py-1 text-sm text-slate-300 hover:bg-white/10"
          title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? '☰' : '⇤'}
        </button>
        <h1 className="text-base font-semibold tracking-wide">Connect Mobile</h1>
        <span className="hidden text-xs text-slate-400 sm:inline">USB / WiFi 投屏 · 电脑控制手机</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="rounded bg-white/10 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/20"
            onClick={() => setWirelessOpen(true)}
          >
            无线连接
          </button>
          {status === 'streaming' ? (
            <button
              className="rounded bg-rose-600 px-3 py-1.5 text-sm hover:bg-rose-500"
              onClick={() => void handleStop()}
            >
              停止投屏
            </button>
          ) : (
            <button
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm hover:bg-emerald-500 disabled:opacity-40"
              disabled={!selectedId}
              onClick={() => void handleStart()}
            >
              开始投屏
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {!sidebarCollapsed && (
          <>
            <aside
              className="flex shrink-0 flex-col overflow-hidden border-r border-white/10"
              style={{ width: sidebarWidth }}
            >
              <div className="px-3 py-2 text-xs font-medium text-slate-400">
                设备（{devices.length}）
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {devices.length === 0 && (
                  <p className="px-3 py-4 text-xs leading-relaxed text-slate-500">
                    没有检测到设备。用 USB 线连接手机并打开 USB 调试，或用右上角「无线连接」。
                  </p>
                )}
                {devices.map((d) => (
                  <button
                    key={d.id}
                    className={`block w-full px-3 py-2 text-left text-sm ${
                      d.id === selectedId ? 'bg-sky-600/25 text-sky-200' : 'hover:bg-white/5'
                    }`}
                    onClick={() => setSelectedId(d.id)}
                  >
                    <div className="truncate">
                      {d.wireless && <span title="无线连接">📶 </span>}
                      {d.model ?? d.id}
                    </div>
                    <div className="truncate text-[11px] text-slate-400">
                      {d.id} · {stateText(d.state)}
                      {d.androidVersion ? ` · Android ${d.androidVersion}` : ''}
                    </div>
                  </button>
                ))}
              </div>

              <div className="space-y-2 border-t border-white/10 px-3 py-3">
                <label className="block text-xs text-slate-400">
                  投屏宽度
                  <select
                    className="mt-1 w-full rounded bg-white/10 px-2 py-1 text-sm text-slate-100"
                    value={targetWidth}
                    onChange={(e) => setTargetWidth(Number(e.target.value))}
                    disabled={status === 'streaming'}
                  >
                    <option value={0}>原始分辨率</option>
                    <option value={360}>360 px</option>
                    <option value={540}>540 px</option>
                    <option value={720}>720 px</option>
                    <option value={1080}>1080 px</option>
                  </select>
                </label>
                <label className="flex items-center justify-between text-xs text-slate-400">
                  <span title="提高采集码率（minicap 路径同时提高帧率），明显减少高分辨率下的丢帧；USB 带宽占用变大">流畅优先</span>
                  <button
                    role="switch"
                    aria-checked={preferFps}
                    disabled={status === 'streaming'}
                    className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${
                      preferFps ? 'bg-emerald-600' : 'bg-white/10'
                    }`}
                    onClick={() => {
                      setPreferFps((v) => {
                        localStorage.setItem(LS_PREFER_FPS, v ? '0' : '1')
                        return !v
                      })
                    }}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                        preferFps ? 'left-[18px]' : 'left-0.5'
                      }`}
                    />
                  </button>
                </label>
                <label className="flex items-center justify-between text-xs text-slate-400">
                  <span title="收起侧栏时把窗口缩成贴合手机画面的小窗，展开侧栏时恢复大窗">收起时缩小窗口</span>
                  <button
                    role="switch"
                    aria-checked={compactOnCollapse}
                    className={`relative h-5 w-9 rounded-full transition-colors ${
                      compactOnCollapse ? 'bg-emerald-600' : 'bg-white/10'
                    }`}
                    onClick={toggleCompactOnCollapse}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                        compactOnCollapse ? 'left-[18px]' : 'left-0.5'
                      }`}
                    />
                  </button>
                </label>
                <p className="text-[11px] leading-relaxed text-slate-500">
                  分辨率越高越清晰，USB 带宽占用也越大。720 一般是清晰度与流畅度的平衡点；
                  若掉帧，可打开「流畅优先」并降低投屏宽度。
                </p>
              </div>

              <KeyboardInput
                deviceId={selectedId}
                enabled={canControl}
                onCapturingChange={handleCapturingChange}
              />
            </aside>
            <div
              className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-sky-500/40"
              title="拖动调整侧栏宽度"
              onMouseDown={startDrag}
            />
          </>
        )}

        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            {devices.length === 0 ? (
              <EmptyHint />
            ) : (
              <DeviceCanvas
                ref={canvasRef}
                width={frameWidth}
                height={frameHeight}
                ready={ready}
                onTap={handleTap}
                onSwipe={handleSwipe}
                disabled={!canControl}
                stretch={stretch}
              />
            )}

            {/* 色调遮罩：仅画面模式下盖在画面上（不影响交互）；整窗模式在根节点渲染 */}
            {mask.scope === 'picture' && <ColorMaskOverlay config={mask} />}

            {canControl && <GestureHelpButton />}

            {(player.error || (status === 'error' && statusMessage)) && (
              <div className="absolute inset-x-4 top-4 rounded border border-rose-500/40 bg-rose-950/80 px-3 py-2 text-xs text-rose-200">
                {player.error ?? statusMessage}
              </div>
            )}
          </div>

          {/* 画面正下方的按键条：导航 + 四向滑动 + 铺满/遮罩/息屏。
              按钮一律 shrink-0 圆角矩形，窗口再窄也不被压变形；
              带字的按钮在小窗口下自动隐藏文字只留图标。 */}
          <div className="flex items-center justify-center gap-1.5 border-t border-white/10 px-4 py-2">
            {NAV_KEYS.map((item) => (
              <button
                key={item.key}
                title={item.title}
                className="h-9 w-10 shrink-0 rounded-lg bg-white/10 text-sm text-slate-200 hover:bg-sky-600/70 disabled:opacity-30"
                disabled={!canControl}
                onClick={() => handlePressKey(item.key)}
              >
                {item.label}
              </button>
            ))}
            <span className="mx-1.5 h-6 w-px shrink-0 bg-white/10" />
            {SWIPE_ACTIONS.map((item) => (
              <button
                key={item.key}
                title={item.title}
                className="h-9 w-10 shrink-0 rounded-lg bg-white/10 text-sm text-slate-200 hover:bg-emerald-600/70 disabled:opacity-30"
                disabled={!canControl}
                onClick={() => triggerSwipeAction(item.key)}
              >
                {item.label}
              </button>
            ))}
            <span className="mx-1.5 h-6 w-px shrink-0 bg-white/10" />
            <button
              title="拉伸铺满：忽略手机宽高比把画面铺满窗口（画面可能变形），点击位置依然精确"
              className={`flex h-9 shrink-0 items-center gap-1 rounded-lg px-3 text-xs disabled:opacity-30 ${
                stretch
                  ? 'bg-sky-600/80 text-white hover:bg-sky-500'
                  : 'bg-white/10 text-slate-200 hover:bg-white/20'
              }`}
              onClick={toggleStretch}
            >
              <span>⛶</span>
              <span className={compactUi ? 'hidden' : ''}>{stretch ? '铺满：开' : '铺满'}</span>
            </button>
            <ColorMaskButton config={mask} compact={compactUi} onChange={handleMaskChange} />
            <button
              title="息屏投屏：关闭自动亮度并把手机亮度压到 0（多数机型背光直接熄灭，投屏不中断）、延长锁屏。退出投屏自动还原。若机型把 0 钳到最低亮度，画面会变暗但不会全黑。"
              className={`flex h-9 shrink-0 items-center gap-1 rounded-lg px-3 text-xs disabled:opacity-30 ${
                screenPower
                  ? 'bg-amber-600/80 text-white hover:bg-amber-500'
                  : 'bg-white/10 text-slate-200 hover:bg-white/20'
              }`}
              disabled={!canControl}
              onClick={() => void toggleScreenPower()}
            >
              <span>🌙</span>
              <span className={compactUi ? 'hidden' : ''}>{screenPower ? '息屏投屏：开' : '息屏投屏'}</span>
            </button>
          </div>
        </main>
      </div>

      <WirelessDialog
        open={wirelessOpen}
        devices={devices}
        onClose={() => setWirelessOpen(false)}
        onConnected={(id) => {
          setSelectedId(id)
          void window.desktop.listDevices().then(setDevices)
        }}
      />

      {/* 整窗遮罩：fixed 盖满窗口（含侧栏/键位条），z-40 高于所有界面元素、低于弹窗 */}
      {mask.scope === 'window' && <ColorMaskOverlay config={mask} />}
    </div>
  )
}

/** 画面左上角的手势帮助：默认只显示一个小「?」按钮，点开展开说明 */
function GestureHelpButton() {
  const [open, setOpen] = useState(false)
  return (
    <div className="absolute left-3 top-3 z-10">
      {open ? (
        <div className="rounded-lg border border-white/10 bg-black/70 px-3 py-2 text-[11px] leading-relaxed text-slate-300 backdrop-blur">
          <div className="mb-1 flex items-center justify-between gap-4">
            <span className="font-medium text-slate-200">操作方式</span>
            <button className="text-slate-400 hover:text-slate-200" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          <p>滚轮 = 上下滚动 · 左右滚轮 = 翻页</p>
          <p>热键 1/2/3/4 = 左滑/右滑/上滑/下滑</p>
          <p>按住拖动 = 任意滑动 · 点画面 = 点手机</p>
          <p>打字捕获中热键自动让路</p>
        </div>
      ) : (
        <button
          title="操作说明"
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/60 text-xs text-slate-300 backdrop-blur hover:bg-black/80 hover:text-white"
          onClick={() => setOpen(true)}
        >
          ?
        </button>
      )}
    </div>
  )
}

function EmptyHint() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-slate-400">
      <p className="text-base text-slate-300">等待手机连接</p>
      <ol className="list-inside list-decimal space-y-1 text-xs text-slate-500">
        <li>手机设置 → 关于手机 → 连点「版本号」7 次开启开发者选项</li>
        <li>开发者选项 → 打开「USB 调试」</li>
        <li>插上 USB 线，手机上点「允许 USB 调试」</li>
        <li>同一 WiFi 下也可以点右上角「无线连接」免插线</li>
      </ol>
    </div>
  )
}

function stateText(state: DeviceInfo['state']): string {
  switch (state) {
    case 'device':
      return '已连接'
    case 'unauthorized':
      return '未授权，请在手机上点允许'
    case 'offline':
      return '离线'
    case 'bootloader':
      return 'bootloader'
    default:
      return '未知'
  }
}

