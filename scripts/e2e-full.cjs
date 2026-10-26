/**
 * 端到端验证（直接读应用自己显示的状态，不依赖注入探针）：
 *   1. 启动投屏，等画面出现
 *   2. 检查画布确实可见且有真实内容
 *   3. 点击画布，确认手机前台发生变化
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

/** 让手机屏幕动起来：静止画面不会产生 H.264 帧 */
function wiggle(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    adb('shell', 'input', 'swipe', '720', '2400', '720', '1400', '150')
  }
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
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text)
    }
    return res.result?.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const problems = []

  // 确保回到桌面并重新开始投屏
  adb('shell', 'input', 'keyevent', '3')
  await sleep(1000)

  const statusText = await evaluate(`document.body.innerText`)
  if (statusText.includes('停止投屏')) {
    await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('停止投屏')); if(b) b.click(); })()`
    )
    await sleep(1200)
  }
  await evaluate(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('开始投屏')); if(b) b.click(); })()`
  )

  // 等画面出现，期间持续让屏幕有变化
  let canvas = null
  for (let attempt = 0; attempt < 10; attempt++) {
    wiggle(800)
    await sleep(400)
    canvas = await evaluate(`
      (() => {
        const c = document.querySelector('canvas');
        if (!c) return null;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let nonBlack = 0, total = 0, sumR = 0, sumG = 0, sumB = 0;
        for (let y = 0; y < c.height; y += Math.max(1, Math.floor(c.height/40))) {
          for (let x = 0; x < c.width; x += Math.max(1, Math.floor(c.width/40))) {
            const i = (y * c.width + x) * 4;
            total++; sumR += d[i]; sumG += d[i+1]; sumB += d[i+2];
            if (d[i] + d[i+1] + d[i+2] > 30) nonBlack++;
          }
        }
        return {
          w: c.width, h: c.height,
          opacity: getComputedStyle(c).opacity,
          nonBlackRatio: +(nonBlack/total).toFixed(3),
          avgColor: [Math.round(sumR/total), Math.round(sumG/total), Math.round(sumB/total)]
        };
      })()
    `)
    if (canvas && canvas.opacity === '1' && canvas.nonBlackRatio > 0.3) break
  }

  const bar = await evaluate(`document.querySelector('.absolute.bottom-3')?.innerText ?? ''`)
  console.log('画布:', JSON.stringify(canvas))
  console.log('状态栏:', JSON.stringify(bar))

  if (!canvas) problems.push('找不到画布')
  else {
    if (canvas.opacity !== '1') problems.push(`画布不可见 opacity=${canvas.opacity}`)
    if (canvas.nonBlackRatio < 0.3) problems.push(`画面内容过少 ${canvas.nonBlackRatio}`)
    if (canvas.w !== 720) problems.push(`画布宽度应为 720，实际 ${canvas.w}`)
  }
  if (!bar.includes('已解') || /已解\s*0\s*帧/.test(bar)) {
    problems.push(`没有解码出帧：${bar}`)
  }

  // 点击验证：点画布中部
  const rect = await evaluate(`
    (() => { const c=document.querySelector('canvas'); const r=c.getBoundingClientRect();
      return { left:r.left, top:r.top, w:r.width, h:r.height }; })()
  `)
  const focusBefore = currentFocus()
  const x = rect.left + rect.w * 0.5
  const y = rect.top + rect.h * 0.5
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(2200)
  const focusAfter = currentFocus()

  console.log(`点击画布中心 (${x.toFixed(0)},${y.toFixed(0)})`)
  console.log(`前台: ${focusBefore}\n   → ${focusAfter}`)
  if (focusBefore === focusAfter) problems.push('点击后手机前台没有变化')

  ws.close()

  if (problems.length) {
    console.error('\n❌ 存在问题：\n - ' + problems.join('\n - '))
    process.exit(1)
  }
  console.log('\n✅ 投屏与点击验证通过')
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
