import { useCallback, useEffect, useRef, useState } from 'react'
import type { DecoderConfig, VideoPacket } from '@shared/types'

export interface H264PlayerState {
  /** 是否已收到解码配置 */
  configured: boolean
  /** 解出的画面宽高 */
  width: number
  height: number
  /** 解码错误 */
  error: string | null
}

interface UseH264PlayerOptions {
  /** 每解出一帧回调一次，用于把帧画到画布 */
  onFrame(frame: VideoFrame): void
}

/** 解码队列积压到多少帧开始跳帧，等下一个关键帧恢复 */
const QUEUE_DROP_THRESHOLD = 10

/**
 * WebCodecs H.264 解码器封装。
 *
 * 只负责解码与时间戳管理，不关心画面怎么显示。
 *
 * 几个必须注意的点：
 * - 配置里带 `description`(avcC) 之后，喂进去的数据必须是 AVCC 格式（4 字节长度前缀），
 *   不能是 Annex-B 起始码格式，主进程的 h264.ts 已经做好了转换。
 * - 每帧必须带上严格递增的 timestamp，否则解码器会丢帧。
 * - VideoFrame 用完必须 close()，否则会迅速耗尽显存导致解码器报错。
 * - 帧数据直接是二进制（IPC 结构化克隆），不再走 base64。
 */
export function useH264Player({ onFrame }: UseH264PlayerOptions) {
  const decoderRef = useRef<VideoDecoder | null>(null)
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame
  const pendingConfigRef = useRef<DecoderConfig | null>(null)
  const needsKeyframeRef = useRef(true)
  const timestampRef = useRef(0)
  /** 上一帧还没被绘制完成时，新帧直接覆盖，保证画面永远是最新的一帧 */
  const lastFrameRef = useRef<VideoFrame | null>(null)

  const [state, setState] = useState<H264PlayerState>({
    configured: false,
    width: 0,
    height: 0,
    error: null
  })

  const releaseFrame = (): void => {
    if (lastFrameRef.current) {
      lastFrameRef.current.close()
      lastFrameRef.current = null
    }
  }

  const decodeNextTimestamp = (): number => {
    timestampRef.current += 1_000_000 / 60
    return Math.round(timestampRef.current)
  }

  const configure = useCallback((config: DecoderConfig) => {
    pendingConfigRef.current = config
    const existing = decoderRef.current
    if (existing && existing.state !== 'closed') existing.close()
    decoderRef.current = null

    const decoder = new VideoDecoder({
      output: (frame) => {
        // 用最新的帧替换旧的，解码速度跟得上采集时不会积压
        if (lastFrameRef.current) lastFrameRef.current.close()
        lastFrameRef.current = frame
        onFrameRef.current(frame)
        // 注意：不要在这里 setState——宽高只在变化时才写，
        // 否则整个 React 树按帧率重渲染，是掉帧的元凶之一
        setState((s) => {
          if (frame.displayWidth === s.width && frame.displayHeight === s.height) return s
          return { ...s, width: frame.displayWidth, height: frame.displayHeight }
        })
      },
      error: (err) => {
        console.error('[decoder]', err)
        setState((s) => ({ ...s, error: String(err) }))
        needsKeyframeRef.current = true
      }
    })

    try {
      decoder.configure({
        codec: config.codec,
        codedWidth: config.width,
        codedHeight: config.height,
        description: base64ToBytes(config.avcC),
        optimizeForLatency: true
      })
      decoderRef.current = decoder
      needsKeyframeRef.current = true
      timestampRef.current = 0
      setState((s) => ({
        ...s,
        configured: true,
        width: config.width ?? s.width,
        height: config.height ?? s.height,
        error: null
      }))
    } catch (err) {
      console.error('[decoder] configure 失败', err)
      setState((s) => ({ ...s, error: String(err) }))
    }
  }, [])

  const append = useCallback((packet: VideoPacket) => {
    const decoder = decoderRef.current
    if (!decoder || decoder.state !== 'configured') return

    // 解码器在 configure 或 flush 之后需要一个关键帧重新同步；
    // 队列积压时也直接丢弃 delta 帧（跳帧），比 reset 解码器恢复快得多：
    // 画面短暂停在旧帧，下一个关键帧（screenrecord 周期内会周期出现）立即跟上。
    if (!packet.keyframe) {
      if (needsKeyframeRef.current || decoder.decodeQueueSize > QUEUE_DROP_THRESHOLD) return
    } else {
      needsKeyframeRef.current = false
    }

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: packet.keyframe ? 'key' : 'delta',
          timestamp: decodeNextTimestamp(),
          data: packet.data
        })
      )
    } catch (err) {
      console.error('[decoder] decode 失败', err)
      needsKeyframeRef.current = true
    }
  }, [])

  const reset = useCallback(() => {
    releaseFrame()
    const decoder = decoderRef.current
    if (decoder && decoder.state !== 'closed') decoder.close()
    decoderRef.current = null
    pendingConfigRef.current = null
    needsKeyframeRef.current = true
    timestampRef.current = 0
    setState({ configured: false, width: 0, height: 0, error: null })
  }, [])

  useEffect(() => {
    return () => {
      releaseFrame()
      const decoder = decoderRef.current
      if (decoder && decoder.state !== 'closed') decoder.close()
      decoderRef.current = null
    }
  }, [])

  return { state, configure, append, reset }
}

/** base64 → Uint8Array（只用于 avcC 这类小数据） */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
