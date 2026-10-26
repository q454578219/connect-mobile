/**
 * 下载运行时依赖到 resources/tools：
 *   1. platform-tools（adb）
 *   2. minicap 预编译产物（Android 9 及以下的回退采集方式需要）
 *
 * 用法：node scripts/fetch-tools.mjs
 */
import { existsSync, mkdirSync, rmSync, copyFileSync, cpSync, statSync, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const toolsDir = join(root, 'resources', 'tools')
mkdirSync(toolsDir, { recursive: true })

async function download(url, dest) {
  console.log('下载', url)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`)
  await pipeline(res.body, createWriteStream(dest))
  console.log(`  → ${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB`)
}

/** 解压 zip 到目录 */
function unzip(zip, dest) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path "${zip}" -DestinationPath "${dest}" -Force`
    ])
  } else {
    execFileSync('unzip', ['-qo', zip, '-d', dest])
  }
}

async function fetchPlatformTools() {
  if (existsSync(join(toolsDir, 'adb.exe'))) {
    console.log('platform-tools 已存在，跳过')
    return
  }
  const zip = join(tmpdir(), 'platform-tools.zip')
  await download(
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
    zip
  )
  const tmp = join(tmpdir(), 'pt-extract')
  unzip(zip, tmp)
  for (const name of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
    copyFileSync(join(tmp, 'platform-tools', name), join(toolsDir, name))
  }
  rmSync(tmp, { recursive: true, force: true })
  console.log('platform-tools 就绪')
}

async function fetchMinicap() {
  const target = join(toolsDir, 'minicap')
  if (existsSync(join(target, 'arm64-v8a'))) {
    console.log('minicap 已存在，跳过')
    return
  }
  const tgz = join(tmpdir(), 'minicap-prebuilt.tgz')
  await download('https://registry.npmjs.org/minicap-prebuilt/-/minicap-prebuilt-2.3.0.tgz', tgz)

  const tmp = join(tmpdir(), 'minicap-extract')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  execFileSync('tar', ['-xzf', tgz, '-C', tmp])

  rmSync(target, { recursive: true, force: true })
  cpSync(join(tmp, 'package', 'prebuilt'), target, { recursive: true })
  rmSync(tmp, { recursive: true, force: true })
  console.log('minicap 就绪')
}

await fetchPlatformTools()
await fetchMinicap()
console.log('\n全部依赖就绪。')
