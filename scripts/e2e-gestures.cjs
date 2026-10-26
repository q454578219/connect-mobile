/**
 * 验证滑动手势与导航键：
 *   1. 打开一个可滚动的界面，模拟从下往上滑，确认内容滚动了（用截图哈希判断）
 *   2. 按返回键，确认退出了界面
 */
const http = require('node:http')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const crypto = require('node:crypto')
const WebSocket = require('ws')

const ADB = join(__dirname, '..', 'resources', 'tools', 'adb.exe')
// 设备序列号可通过环境变量指定，默认用模拟器
const DEVICE = process.env.TEST_DEVICE || 'emulator-5554'

function adb(...args) {
  return spawnSync(ADB, ['-s', DEVICE, ...args], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  })
}

/** 截屏后算哈希，用来判断画面是否变化 */
function screenHash() {
  const r = spawnSync(ADB, ['-s', DEVICE, 'exec-out', 'screencap', '-p'], {
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  })
  return crypto.createHash('md5').update(r.stdout).digest('hex').slice(0, 12)
}

function currentFocus() {
  const r = adb('shell', 'dumpsys', 'window')
  const text = r.stdout.toString()
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

async function connect() {
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
    if (res.result?.exceptionDetails) {
      throw new Error('页面异常: ' + res.result.exceptionDetails.text)
    }
    return res.result?.result?.value
  }
  return { ws, evaluate }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 在投屏画布上做一次从 (fx1,fy1) 到 (fx2,fy2) 的拖动，参数是画布内的比例 */
async function dragOnCanvas(evaluate, fx1, fy1, fx2, fy2) {
  return evaluate(`
    (() => {
      const c = document.querySelector('canvas');
      if (!c) return 'no canvas';
      const rect = c.getBoundingClientRect();
      const x1 = rect.left + rect.width * ${fx1};
      const y1 = rect.top + rect.height * ${fy1};
      const x2 = rect.left + rect.width * ${fx2};
      const y2 = rect.top + rect.height * ${fy2};
      const opts = (x, y) => ({ clientX: x, clientY: y, pointerId: 7, bubbles: true, isPrimary: true, pointerType: 'mouse' });
      c.dispatchEvent(new PointerEvent('pointerdown', opts(x1, y1)));
      c.dispatchEvent(new PointerEvent('pointerup', opts(x2, y2)));
      return { x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2) };
    })()
  `)
}

async function clickNav(evaluate, title) {
  return evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.title === ${JSON.stringify(title)});
      if (!btn) return 'no button';
      btn.click();
      return 'clicked';
    })()
  `)
}

async function main() {
  const { ws, evaluate } = await connect()
  const problems = []

  // 确保在投屏中
  const streaming = await evaluate(`document.body.innerText.includes('投屏中')`)
  if (!streaming) throw new Error('应用当前不在投屏状态，请先启动投屏')

  // 打开系统设置（列表可滚动）
  adb('shell', 'am', 'force-stop', 'com.android.settings')
  adb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS')
  await sleep(2500)
  const focusSettings = currentFocus()
  console.log('当前前台:', focusSettings)

  const hashBefore = screenHash()
  // 从靠近屏幕下沿开始拖，落点靠上，这样整条轨迹都落在 ScrollView 内
  const swipe = await dragOnCanvas(evaluate, 0.5, 0.85, 0.5, 0.34)
  await sleep(2000)
  const hashAfter = screenHash()

  console.log('画布滑动:', JSON.stringify(swipe))
  console.log('滑屏前 hash:', hashBefore, ' 滑屏后 hash:', hashAfter)

  if (hashBefore === hashAfter) {
    problems.push('滑动后画面没有变化，手势可能没生效')
  }

  // 导航键：返回
  const focusBeforeBack = currentFocus()
  const nav = await clickNav(evaluate, '返回')
  await sleep(2000)
  const focusAfterBack = currentFocus()
  console.log('返回键:', nav, ' 前台:', focusBeforeBack, '→', focusAfterBack)
  if (focusBeforeBack === focusAfterBack) {
    problems.push('按返回键后前台没有变化')
  }

  // 导航键：桌面
  const navHome = await clickNav(evaluate, '桌面')
  await sleep(2000)
  const focusHome = currentFocus()
  console.log('桌面键:', navHome, ' 前台:', focusHome)
  if (focusHome && !/launcher/i.test(focusHome)) {
    problems.push(`按桌面键后没有回到桌面，当前为 ${focusHome}`)
  }

  ws.close()

  if (problems.length) {
    console.error('\n❌ 存在问题：\n - ' + problems.join('\n - '))
    process.exit(1)
  }
  console.log('\n✅ 滑动与导航键验证通过')
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
