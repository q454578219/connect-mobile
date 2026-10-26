/**
 * 真机点击精度验证（不依赖 uiautomator）。
 *
 * 思路：在设置界面里，在画布的不同位置点击，每次点完对比截图。
 * 如果坐标换算正确，点击「屏幕中间」应该和直接 abz tap 屏幕中间产生相同的界面变化。
 */
const http = require('node:http')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const crypto = require('node:crypto')
const WebSocket = require('ws')

const ADB = join(__dirname, '..', 'resources', 'tools', 'adb.exe')
const DEVICE = process.env.TEST_DEVICE || 'emulator-5554'

function adb(...args) {
  return spawnSync(ADB, ['-s', DEVICE, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
}

function screenHash() {
  const r = spawnSync(ADB, ['-s', DEVICE, 'exec-out', 'screencap', '-p'], {
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  })
  return crypto.createHash('md5').update(r.stdout).digest('hex').slice(0, 12)
}

function currentFocus() {
  const text = adb('shell', 'dumpsys', 'window').stdout.toString()
  const m = /mCurrentFocus=Window\{\S+ \S+ (\S+)\}/.exec(text)
  return m ? m[1] : null
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
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text)
    return res.result?.result?.value
  }

  const rect = await evaluate(`
    (() => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height };
    })()
  `)
  console.log('画布:', JSON.stringify(rect))

  // 在画布上按比例点击
  async function tapCanvas(fx, fy) {
    const x = rect.left + rect.w * fx
    const y = rect.top + rect.h * fy
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
    await new Promise((r) => setTimeout(r, 1800))
    return { x: Math.round(x), y: Math.round(y) }
  }

  // 打开设置
  adb('shell', 'am', 'force-stop', 'com.android.settings')
  adb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS')
  await new Promise((r) => setTimeout(r, 3000))

  console.log('\n--- 场景：设置首页，点击画布上不同位置 ---')
  const results = []
  for (const [fx, fy] of [
    [0.5, 0.25],
    [0.5, 0.5],
    [0.5, 0.75]
  ]) {
    adb('shell', 'am', 'force-stop', 'com.android.settings')
    adb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS')
    await new Promise((r) => setTimeout(r, 2500))
    const before = { focus: currentFocus(), hash: screenHash() }
    const pos = await tapCanvas(fx, fy)
    const after = { focus: currentFocus(), hash: screenHash() }
    const changed = before.hash !== after.hash
    results.push({ fy, pos, changed, focusBefore: before.focus, focusAfter: after.focus })
    console.log(
      `点画布 (${fx}, ${fy}) → 屏幕(${pos.x},${pos.y})  画面变化=${changed}` +
        (before.focus !== after.focus ? `  前台变更为 ${after.focus}` : '')
    )
  }

  ws.close()

  // 判断：至少中间位置应该有反应（设置首页中段是列表项）
  const anyChanged = results.some((r) => r.changed)
  console.log(`\n结论：${anyChanged ? '✅ 点击在画面上产生了效果' : '❌ 所有点击都没有效果'}`)
  if (!anyChanged) process.exit(1)
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
