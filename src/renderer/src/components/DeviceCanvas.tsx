import { useEffect, useImperativeHandle, useRef, forwardRef, useCallback } from 'react'

interface DeviceCanvasProps {
  /** 画面原始宽高（手机侧像素） */
  width: number
  height: number
  /** 画面是否已就绪（首次拿到帧之前显示占位） */
  ready: boolean
  /** 画布上的点击，坐标为手机侧像素 */
  onTap(point: { x: number; y: number }): void
  /** 画布上的滑动，坐标为手机侧像素 */
  onSwipe(action: {
    from: { x: number; y: number }
    to: { x: number; y: number }
    durationMs: number
  }): void
  /** 是否禁用交互 */
  disabled: boolean
  /** 拉伸铺满：忽略手机宽高比，把画面强制铺满窗口（默认关闭 = 保持比例留黑边） */
  stretch?: boolean
}

export interface DeviceCanvasHandle {
  /** 把一帧画到画布上；由解码器在拿到新帧时主动调用 */
  draw(source: CanvasImageSource, width: number, height: number): void
}

/** 判定为滑动的最小位移（手机侧像素），低于这个值算点击 */
const SWIPE_THRESHOLD = 8

/** 滚轮累积多少像素（手机侧）才合成一次滑动 */
const WHEEL_STEP = 120
/** 两次滚轮滑动之间的最小间隔（ms），防止 adb 进程堆积 */
const WHEEL_COOLDOWN_MS = 250
/** 滚轮合成的滑动手势占屏幕高度的比例 */
const WHEEL_SWIPE_SPAN = 0.32

/**
 * 手机画面画布。
 *
 * 重绘由外部驱动（每解出一个 VideoFrame 调一次 draw），不用定时器轮询，
 * 这样帧率和真实码流严格一致，也不会空转耗 CPU。
 *
 * 点击坐标要反向换算回手机像素：用 画布显示尺寸 / 画面原始尺寸 得到缩放比。
 */
export const DeviceCanvas = forwardRef<DeviceCanvasHandle, DeviceCanvasProps>(function DeviceCanvas(
  { width, height, ready, onTap, onSwipe, disabled, stretch = false },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef({ width, height })
  sizeRef.current = { width, height }

  useImperativeHandle(
    ref,
    () => ({
      draw(source, w, h) {
        const canvas = canvasRef.current
        if (!canvas) return
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w
          canvas.height = h
        }
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        ctx.drawImage(source, 0, 0, w, h)
      }
    }),
    []
  )

  // 画面尺寸变化时清一下画布，避免上一路画面的残留
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = width
    canvas.height = height
  }, [width, height])

  const toDevice = useCallback((clientX: number, clientY: number, rect: DOMRect) => {
    return {
      x: ((clientX - rect.left) / rect.width) * sizeRef.current.width,
      y: ((clientY - rect.top) / rect.height) * sizeRef.current.height
    }
  }, [])

  // 滚轮 → 合成一次上下（或左右）滑动手势。
  // 增量累积到阈值才发一次，且带冷却：adb shell input 是新起进程，发太快会堆积。
  const wheelAccum = useRef({ x: 0, y: 0 })
  const lastWheelSwipeAt = useRef(0)

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (disabled) return
      // 触控板的双指滚动会高频触发，交给累积逻辑平滑；一次整格滚动（deltaMode 非像素）按整格算
      const scale = e.deltaMode === 0 ? 1 : sizeRef.current.height / 20
      const accum = wheelAccum.current
      accum.x += e.deltaX * scale
      accum.y += e.deltaY * scale

      const now = Date.now()
      if (now - lastWheelSwipeAt.current < WHEEL_COOLDOWN_MS) return

      const w = sizeRef.current.width
      const h = sizeRef.current.height
      const spanX = w * WHEEL_SWIPE_SPAN
      const spanY = h * WHEEL_SWIPE_SPAN

      // 哪个方向先攒够一步就先滚哪个方向
      let action: Parameters<typeof onSwipe>[0] | null = null
      if (Math.abs(accum.y) >= WHEEL_STEP) {
        const down = accum.y > 0
        action = {
          from: { x: w / 2, y: down ? h * 0.62 : h * 0.38 },
          to: { x: w / 2, y: down ? h * 0.62 - spanY : h * 0.38 + spanY },
          durationMs: 180
        }
      } else if (Math.abs(accum.x) >= WHEEL_STEP) {
        const right = accum.x > 0
        action = {
          from: { x: right ? w * 0.62 : w * 0.38, y: h / 2 },
          to: { x: right ? w * 0.62 - spanX : w * 0.38 + spanX, y: h / 2 },
          durationMs: 180
        }
      }

      if (action) {
        accum.x = 0
        accum.y = 0
        lastWheelSwipeAt.current = now
        onSwipe(action)
      }
    },
    [disabled, onSwipe]
  )

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black/40">
      <canvas
        ref={canvasRef}
        className="device-canvas shadow-2xl"
        style={
          stretch
            ? {
                // 铺满：无视宽高比强拉到容器大小，坐标换算按显示矩形百分比，依然精确
                width: '100%',
                height: '100%',
                opacity: ready ? 1 : 0,
                transition: 'opacity 200ms'
              }
            : {
                aspectRatio: `${width} / ${height}`,
                height: '100%',
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                opacity: ready ? 1 : 0,
                transition: 'opacity 200ms'
              }
        }
        onPointerDown={(e) => {
          if (disabled) return
          const target = e.currentTarget
          const rect = target.getBoundingClientRect()
          const startPoint = toDevice(e.clientX, e.clientY, rect)
          const startedAt = Date.now()
          // 监听挂在 window 上而不是画布上：指针拖出画布范围时也能正常收到抬起事件
          const pointerId = e.pointerId

          const handleUp = (upEvent: PointerEvent) => {
            if (upEvent.pointerId !== pointerId) return
            window.removeEventListener('pointerup', handleUp)
            window.removeEventListener('pointercancel', handleUp)
            const endPoint = toDevice(upEvent.clientX, upEvent.clientY, rect)
            const distance = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y)
            if (distance < SWIPE_THRESHOLD) {
              onTap(startPoint)
            } else {
              onSwipe({
                from: startPoint,
                to: endPoint,
                durationMs: Math.max(80, Date.now() - startedAt)
              })
            }
          }

          window.addEventListener('pointerup', handleUp)
          window.addEventListener('pointercancel', handleUp)
        }}
        onWheel={onWheel}
      />
    </div>
  )
})
