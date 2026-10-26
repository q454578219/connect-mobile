import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAdbPath, adbRunOn } from './adb'
import { MinicapParser, type MinicapFrame } from './minicap-parser'

/** minicap 输出的每帧 JPEG，已从原始流里切好 */
export type Frame = MinicapFrame

export interface MinicapOptions {
  deviceId: string
  abi: string
  sdk: number
  /** 期望画面宽度上限，0 表示原始分辨率 */
  targetWidth?: number
  /** 期望画面高度上限，0 表示原始分辨率 */
  targetHeight?: number
  /** 期望帧率，实际帧率还受设备与 USB 带宽限制 */
  fps?: number
}

/** minicap 资源在仓库里的位置（开发态 / 打包态都能找到） */
function minicapRoot(): string {
  const candidates = [
    join(process.cwd(), 'resources', 'tools', 'minicap'),
    join(process.resourcesPath ?? '', 'tools', 'minicap')
  ]
  for (const dir of candidates) if (dir && existsSync(dir)) return dir
  return candidates[0]
}

/**
 * minicap 的 so 是按 Android API 等级编译的。
 *
 * 预编译包只提供到 android-28，更新的系统用 android-28 的 so 可以正常工作
 * （JPEG 编码这层接口没变），所以这里做向下取整。
 */
function pickAndroidVersion(sdk: number): number {
  const available = [10, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28]
  const usable = available.filter((v) => v <= sdk)
  return usable.length > 0 ? usable[usable.length - 1] : 28
}

/** 从 `[ro.product.cpu.abi]: [arm64-v8a]` 里挑出 minicap 支持的 ABI */
function pickAbi(abi: string): string {
  const supported = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']
  if (supported.includes(abi)) return abi
  if (abi.startsWith('x86')) return abi === 'x86_64' ? 'x86_64' : 'x86'
  return 'arm64-v8a'
}

/** 把两个二进制推送到设备 */
async function pushBinaries(deviceId: string, abi: string, sdk: number): Promise<void> {
  const root = minicapRoot()
  const version = pickAndroidVersion(sdk)
  const localBin = join(root, abi, 'bin', 'minicap-nopie')
  const localSo = join(root, abi, 'lib', `android-${version}`, 'minicap.so')

  if (!existsSync(localBin) || !existsSync(localSo)) {
    throw new Error(
      `缺少 minicap 资源（${abi}/android-${version}）。请确认 resources/tools/minicap 目录完整。`
    )
  }

  await runAdb(['-s', deviceId, 'shell', 'mkdir', '-p', '/data/local/tmp/minicap'])
  await runAdb(['-s', deviceId, 'push', localBin, '/data/local/tmp/minicap/minicap'])
  await runAdb(['-s', deviceId, 'push', localSo, '/data/local/tmp/minicap/minicap.so'])
  await runAdb(['-s', deviceId, 'shell', 'chmod', '755', '/data/local/tmp/minicap/minicap'])
}

function runAdb(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveAdbPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => (stderr += c))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`adb ${args.slice(2).join(' ')} 失败：${stderr.trim()}`))
    })
  })
}

/** 读取设备真实分辨率，用于按比例换算目标高度 */
async function readRealSize(deviceId: string): Promise<{ width: number; height: number } | null> {
  try {
    const out = await adbRunOn(deviceId, ['shell', 'wm', 'size'], 8_000)
    const match = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out)
    if (!match) return null
    const width = Number(match[1])
    const height = Number(match[2])
    return width > 0 && height > 0 ? { width, height } : null
  } catch {
    return null
  }
}

/**
 * 启动一个 minicap 采集会话。
 *
 * `onFrame` 回调里拿到的是完整 JPEG，直接就能给渲染进程解码显示。
 */
export async function startMinicap(
  options: MinicapOptions,
  onFrame: (frame: Frame) => void,
  onError: (err: Error) => void
): Promise<() => void> {
  const abi = pickAbi(options.abi)
  await pushBinaries(options.deviceId, abi, options.sdk)

  const fps = options.fps ?? 30

  // minicap 的参数语法是 `-P <真实宽>x<真实高>@<虚拟宽>x<虚拟高>/<帧率>`。
  // 真实尺寸留空表示「用设备当前显示尺寸」，虚拟尺寸给 0x0 表示同真实尺寸。
  //
  // 指定了目标宽度时，高度必须自己按设备真实比例算出来给 minicap，
  // 传 0 或写死 16:9 都会让非该比例的屏幕（20:9 等）画面变形。
  let project = `@0x0/${fps}`
  if (options.targetWidth) {
    const real = await readRealSize(options.deviceId)
    const targetHeight =
      options.targetHeight ??
      (real ? Math.round((options.targetWidth * real.height) / real.width) : 0)
    const size = targetHeight ? `${options.targetWidth}x${targetHeight}` : ''
    project = `${size}@${size || '0x0'}/${fps}`
  }

  const args = [
    '-s',
    options.deviceId,
    'shell',
    'LD_LIBRARY_PATH=/data/local/tmp/minicap',
    '/data/local/tmp/minicap/minicap',
    '-P',
    project
  ]

  const child: ChildProcess = spawn(resolveAdbPath(), args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const parser = new MinicapParser(onFrame)
  child.stdout?.on('data', (chunk: Buffer) => {
    try {
      parser.push(chunk)
    } catch (err) {
      onError(err as Error)
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (text) console.warn('[minicap]', text)
  })
  child.on('error', onError)
  child.on('close', (code) => {
    if (code !== 0 && code !== null) onError(new Error(`minicap 退出（code ${code}）`))
  })

  return () => {
    if (!child.killed) child.kill()
  }
}
