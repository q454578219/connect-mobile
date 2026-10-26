/**
 * 精确点击验证：点击桌面上「微信」图标的中心，确认能打开它。
 *
 * 之前的测试点的是屏幕正中心，那里正好是两个图标的边界，所以没反应。
 * 这里按图标的真实 bounds 取中心点，才能真正验证坐标换算精度。
 */
const http = require('node:http')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const WebSocket = require('ws')

const ADB = join(__dirname, '..', 'resources', 'tools', 'adb.exe')
const DEVICE = process.env.TEST_DEVICE || 'emulator-5554'

function adb(...args) {
  return spawnSync(ADB, ['-s', DEVICE, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
}

function currentFocus() {
  const text = adb('shell', 'dumpsys', 'window').stdout.toString()
  const m = /mCurrentFocus=Window\{\S+ \S+ (\S+)\}/.exec(text)
  return m ? m[1] : null
}

/** 从当前界面找出指定文字的图标中心（设备像素） */
function findIconCenter(label) {
  adb('shell', 'rm', '-f', '/sdcard/icon.xml')
  adb('shell', 'uiautomator', 'dump', '/sdcard/icon.xml')
  const xml = adb('shell', 'cat', '/sdcard/icon.xml').stdout.toString('utf8')
  const re = /<node[^>]*text="([^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g
  let m
  while ((m = re.exec(xml)) !== null) {
    if (m[1] === label) {
      const [x1, y1, x2, y2] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])]
      return { cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) }
    }
  }
  return null
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve(JSON.parse(body)))
      })
      .on('error', reject)
  })
}

async function main() {
  const [w, h] = adb('shell', 'wm', 'size')
    .stdout.toString()
    .match(/(\d+)x(\d+)/)
    .slice(1)
    .map(Number)
  console.log(`设备分辨率: ${w}x${h}`)

  adb('shell', 'input', 'keyevent', '3')
  await new Promise((r) => setTimeout(r, 2000))

  const target = findIconCenter('微信')
  if (!target) {
    console.error('没在桌面上找到「微信」图标，跳过')
    process.exit(1)
  }
  console.log(`微信图标中心（设备坐标）: (${target.cx}, ${target.cy})`)

  const list = await getJson('http://127.0.0.1:9333/json/list')
  const page = list.find((t) => t.type === 'page' && t.title.includes('Connect'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  await new Promise((r) => ws.on('open', r))
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const msgId = ++id
      pending.set(msgId, resolve)
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    return res.result?.result?.value
  }

  const rect = await evaluate(`
    (() => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height, cw: c.width, ch: c.height };
    })()
  `)

  // 设备坐标 → 画布坐标（按比例映射）
  const x = rect.left + rect.w * (target.cx / w)
  const y = rect.top + rect.h * (target.cy / h)
  console.log(`映射到画布: (${x.toFixed(0)}, ${y.toFixed(0)})`)

  const before = currentFocus()
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
  await new Promise((r) => setTimeout(r, 3000))
  const after = currentFocus()

  console.log(`前台: ${before}\n   → ${after}`)
  ws.close()

  if (before === after) {
    console.error('❌ 点击后没有打开微信')
    process.exit(1)
  }
  console.log('✅ 精确点击验证通过，成功打开目标应用')
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
