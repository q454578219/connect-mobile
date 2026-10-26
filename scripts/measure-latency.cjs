/**
 * 延迟测量：量化「操作 → 画面更新」的端到端时间。
 *
 * 测量方法：
 *   1. 记录点击发生的时间 t0
 *   2. 轮询画布像素，直到画面内容发生变化，记 t1
 *   3. 差值就是用户感知到的延迟
 *
 * 同时在手机侧对比：直接 adb tap 后画面变化的时间，
 * 用来区分「采集/解码慢」和「注入慢」。
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
  if (!page) throw new Error('应用页面没找到，请先启动应用并开始投屏')
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
  return { ws, send, evaluate }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 取画布内容的指纹（降采样后求 hash），用于判断画面是否变化 */
const CANVAS_HASH_EXPR = `
  (() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const ctx = c.getContext('2d');
    const w = 32, h = 32;
    // 用离屏画布降采样，比读全图快得多
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(c, 0, 0, w, h);
    const d = octx.getImageData(0, 0, w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum = (sum * 31 + d[i] + d[i+1] * 3 + d[i+2] * 7) >>> 0;
    return sum;
  })()
`

async function main() {
  const { ws, send, evaluate } = await connect()

  const bar = await evaluate(`document.querySelector('.absolute.bottom-3')?.innerText ?? ''`)
  console.log('投屏状态:', JSON.stringify(bar))
  if (!bar.includes('投屏中')) throw new Error('当前没有在投屏，请先点「开始投屏」')

  const rect = await evaluate(`
    (() => { const c=document.querySelector('canvas'); const r=c.getBoundingClientRect();
      return { left:r.left, top:r.top, w:r.width, h:r.height }; })()
  `)

  console.log('\n===== 测试 1：点击 → 画面变化 =====')
  const clickLatencies = []

  for (let round = 0; round < 3; round++) {
    // 让画面稳定下来
    await sleep(600)
    const before = await evaluate(CANVAS_HASH_EXPR)

    const x = rect.left + rect.w * (0.3 + round * 0.2)
    const y = rect.top + rect.h * 0.5
    const t0 = Date.now()

    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })

    // 每 8ms 查一次画面是否变化
    let changedAt = null
    for (let i = 0; i < 200; i++) {
      const h = await evaluate(CANVAS_HASH_EXPR)
      if (h !== null && h !== before) {
        changedAt = Date.now()
        break
      }
      await sleep(8)
    }

    const latency = changedAt ? changedAt - t0 : null
    if (latency !== null) clickLatencies.push(latency)
    console.log(`  第 ${round + 1} 次: ${latency === null ? '画面未变化' : latency + ' ms'}`)
    await sleep(1200)
  }

  // 恢复正常界面
  adb('shell', 'input', 'keyevent', '4')
  await sleep(500)

  console.log('\n===== 测试 2：画布刷新率（H.264 出帧间隔）=====')
  // 持续制造画面变化，统计画布内容变化的频率
  adb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS')
  await sleep(1500)

  const samples = []
  let lastHash = await evaluate(CANVAS_HASH_EXPR)
  const startTime = Date.now()

  // 后台用 adb 持续滚动，制造画面变化
  const wiggler = setInterval(() => {
    adb('shell', 'input', 'swipe', '720', '2200', '720', '1600', '100')
  }, 120)

  while (Date.now() - startTime < 4000) {
    const h = await evaluate(CANVAS_HASH_EXPR)
    const now = Date.now()
    if (h !== null && h !== lastHash) {
      samples.push(now)
      lastHash = h
    }
    await sleep(4)
  }
  clearInterval(wiggler)

  if (samples.length > 1) {
    const gaps = []
    for (let i = 1; i < samples.length; i++) gaps.push(samples[i] - samples[i - 1])
    gaps.sort((a, b) => a - b)
    const median = gaps[Math.floor(gaps.length / 2)]
    const p90 = gaps[Math.floor(gaps.length * 0.9)]
    const fps = (samples.length / 4).toFixed(1)
    console.log(`  画布更新次数: ${samples.length} 次 / 4 秒  => ${fps} fps`)
    console.log(`  帧间隔中位数: ${median} ms`)
    console.log(`  帧间隔 P90:   ${p90} ms`)
  } else {
    console.log('  采样太少，画面可能没在变化')
  }

  const barEnd = await evaluate(`document.querySelector('.absolute.bottom-3')?.innerText ?? ''`)
  console.log('\n结束时状态:', JSON.stringify(barEnd))

  console.log('\n===== 结果汇总 =====')
  if (clickLatencies.length) {
    const avg = Math.round(clickLatencies.reduce((a, b) => a + b, 0) / clickLatencies.length)
    const max = Math.max(...clickLatencies)
    console.log(`点击到画面更新：平均 ${avg} ms，最慢 ${max} ms`)
  }

  ws.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
