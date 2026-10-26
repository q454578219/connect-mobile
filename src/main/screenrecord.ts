import { spawn, type ChildProcess } from 'node:child_process'
import type { AccessUnit } from './h264'
import { AnnexBSplitter, FrameAssembler } from './h264'
import { resolveAdbPath, adbRunOn } from './adb'

export interface ScreenrecordOptions {
  deviceId: string
  /** 目标画面宽度，0 或未给表示原始分辨率 */
  targetWidth?: number
  /** 码率（bps），越大越清晰也越占带宽 */
  bitRate?: number
  /** 重启时复用已解析的尺寸，省掉一次 adb 往返（180s 重启间隙更短） */
  cachedSize?: { width: number; height: number }
}

/** 解码器配置，变化时（SPS/PPS 更新）需要通知渲染进程重新 configure */
export interface DecoderConfig {
  codec: string
  avcC: string
  width?: number
  height?: number
}

export interface ScreenrecordCallbacks {
  onConfig(config: DecoderConfig): void
  onFrame(frame: AccessUnit): void
  onError(err: Error): void
  /** 实际采集尺寸（可能是按 targetWidth 缩小后的尺寸） */
  onSize(size: { width: number; height: number }): void
}

/**
 * 读取设备真实分辨率，用来算 screenrecord 的输出尺寸。
 *
 * screenrecord 要求 --size 的长宽都是 2 的倍数，否则会报错退出，
 * 所以这里统一取偶。
 */
async function resolveSize(
  deviceId: string,
  targetWidth: number
): Promise<{ width: number; height: number }> {
  const out = await adbRunOn(deviceId, ['shell', 'wm', 'size'], 8_000)
  const match = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out)
  if (!match) throw new Error('读取设备分辨率失败，无法确定 screenrecord 输出尺寸')

  const realW = Number(match[1])
  const realH = Number(match[2])
  if (!targetWidth || targetWidth >= realW) {
    return { width: even(realW), height: even(realH) }
  }
  const scale = targetWidth / realW
  return { width: even(targetWidth), height: even(Math.round(realH * scale)) }
}

function even(value: number): number {
  const rounded = Math.round(value)
  return rounded % 2 === 0 ? rounded : rounded + 1
}

/**
 * 启动 screenrecord 采集会话。
 *
 * `adb exec-out screenrecord --output-format=h264 -` 会把 H.264 裸流直接打到标准输出，
 * 这里负责把 Annex-B 切成按帧的 AVCC 数据，交给渲染进程用 WebCodecs 解码。
 *
 * 相比 minicap 的优势：是系统自带程序，不用往设备推二进制，
 * 也就不会踩到 Android 10+ 上 minicap 符号不兼容导致完全不可用的问题。
 */
export async function startScreenrecord(
  options: ScreenrecordOptions,
  callbacks: ScreenrecordCallbacks
): Promise<() => void> {
  const { width, height } =
    options.cachedSize ?? (await resolveSize(options.deviceId, options.targetWidth ?? 0))
  const bitRate = options.bitRate ?? 4_000_000
  callbacks.onSize({ width, height })

  const args = [
    '-s',
    options.deviceId,
    'exec-out',
    'screenrecord',
    '--output-format=h264',
    `--size=${width}x${height}`,
    `--bit-rate=${bitRate}`,
    // 单次最多录 180 秒，超时后自动重启，避免用户长时间使用后画面停住
    '--time-limit=180',
    '-'
  ]

  const child: ChildProcess = spawn(resolveAdbPath(), args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const splitter = new AnnexBSplitter()
  const assembler = new FrameAssembler()
  let lastConfigKey = ''
  let stopped = false
  /** 到时间上限后重启用的定时器 */
  let restartTimer: NodeJS.Timeout | undefined
  /** 重启后的新会话停止函数 */
  let stopDelegate: (() => void) | undefined

  const emitConfig = (): void => {
    const config = assembler.getConfig()
    if (!config) return
    const key = config.codec + ':' + config.avcC.length + ':' + config.width + 'x' + config.height
    if (key === lastConfigKey) return
    lastConfigKey = key
    callbacks.onConfig({
      codec: config.codec,
      avcC: Buffer.from(config.avcC).toString('base64'),
      width: config.width,
      height: config.height
    })
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    if (stopped) return
    try {
      const units = splitter.push(new Uint8Array(chunk))
      const { frames } = assembler.push(units)
      emitConfig()
      for (const frame of frames) callbacks.onFrame(frame)
    } catch (err) {
      callbacks.onError(err as Error)
    }
  })

  let stderrText = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString('utf8')
    if (stderrText.length > 4_000) stderrText = stderrText.slice(-2_000)
  })

  child.on('error', (err) => callbacks.onError(err))
  child.on('close', (code) => {
    if (stopped) return
    // screenrecord 到 --time-limit 会自己正常退出。这时自动重启一轮，
    // 让用户长时间投屏时画面不会停住。
    if (code === 0 || code === null) {
      restartTimer = setTimeout(() => {
        restartTimer = undefined
        if (stopped) return
        // 尺寸刚解析过，直接复用，缩短重启间隙
        const next = startScreenrecord({ ...options, cachedSize: { width, height } }, callbacks)
        next
          .then((stopNext) => {
            // 上层拿到的 stop 引用要能停掉重启后的新会话
            if (stopped) stopNext()
            else stopDelegate = stopNext
          })
          .catch((err) => callbacks.onError(err as Error))
      }, 150)
      return
    }
    const detail = stderrText.trim() || `退出码 ${code}`
    callbacks.onError(new Error(`screenrecord 已结束：${detail}`))
  })

  return () => {
    stopped = true
    if (restartTimer) clearTimeout(restartTimer)
    stopDelegate?.()
    if (!child.killed) child.kill()
  }
}
