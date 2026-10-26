import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 执行 adb 命令的结果 */
interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

let cachedAdbPath: string | undefined

/**
 * 解析 adb 可执行文件的位置。
 *
 * 优先级：环境变量覆盖（用于测试 / 指定自定义 adb）→ 内置 platform-tools → PATH 里的 adb。
 * 内置一份是为了让用户机器上不用另装 Android SDK。
 */
export function resolveAdbPath(): string {
  if (cachedAdbPath) return cachedAdbPath

  // 环境变量可以指向任意可执行文件（测试时指向假 adb 脚本）
  const override = process.env.CONNECT_MOBILE_ADB
  if (override && existsSync(override)) {
    cachedAdbPath = override
    return override
  }

  const candidates = [
    // 开发态：项目根目录
    join(process.cwd(), 'resources', 'tools', 'adb.exe'),
    // 打包态：extraResources 输出的目录
    join(process.resourcesPath ?? '', 'tools', 'adb.exe')
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      cachedAdbPath = candidate
      return candidate
    }
  }
  cachedAdbPath = 'adb'
  return cachedAdbPath
}

/** 同步执行一条 adb 命令，收集完整输出 */
export function adbExec(args: string[], timeoutMs = 15_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveAdbPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`adb ${args.join(' ')} 超时（${timeoutMs}ms）`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 0 })
    })
  })
}

/** 执行 adb 命令，非 0 退出码直接抛错 */
export async function adbRun(args: string[], timeoutMs?: number): Promise<string> {
  const { stdout, stderr, code } = await adbExec(args, timeoutMs)
  if (code !== 0) {
    throw new Error(`adb ${args.join(' ')} 失败（退出码 ${code}）：${stderr.trim() || stdout.trim()}`)
  }
  return stdout
}

/** 对指定设备执行 adb 命令（自动补 -s 序列号） */
export function adbRunOn(deviceId: string, args: string[], timeoutMs?: number): Promise<string> {
  return adbRun(['-s', deviceId, ...args], timeoutMs)
}

/** 打开一个可读写的 adb 子进程通道，用于 shell 交互（推文件、读原始流） */
export function adbSpawn(deviceId: string, args: string[]) {
  return spawn(resolveAdbPath(), ['-s', deviceId, ...args], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}
