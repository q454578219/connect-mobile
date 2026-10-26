/**
 * 真机键盘输入验证：
 *   1. 打开设置搜索框
 *   2. 通过应用输入一段英文
 *   3. 用 uiautomator 读回输入框内容，确认字符真的进去了
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

/** 读取界面上所有输入框的内容 */
function readEditTexts() {
  adb('shell', 'rm', '-f', '/sdcard/kb.xml')
  adb('shell', 'uiautomator', 'dump', '/sdcard/kb.xml')
  const xml = adb('shell', 'cat', '/sdcard/kb.xml').stdout.toString('utf8')
  const out = []
  const re = /<node[^>]*class="[^"]*(?:EditText|AutoCompleteTextView)[^"]*"[^>]*>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const text = (/text="([^"]*)"/.exec(m[0]) || [])[1] || ''
    out.push(text)
  }
  return out
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

  const problems = []

  // 1. 打开设置搜索界面（自带输入焦点）
  adb('shell', 'am', 'force-stop', 'com.android.settings')
  adb('shell', 'am', 'start', '-a', 'com.android.settings.action.SETTINGS_SEARCH')
  await new Promise((r) => setTimeout(r, 3500))
  const before = readEditTexts()
  console.log('输入前输入框内容:', JSON.stringify(before))

  // 2. 通过应用发送英文
  const payload = 'hello123'
  await evaluate(`window.desktop.sendText(${JSON.stringify(DEVICE)}, ${JSON.stringify(payload)})`)
  await new Promise((r) => setTimeout(r, 2000))
  const afterEnglish = readEditTexts()
  console.log('发送英文后:', JSON.stringify(afterEnglish))

  const englishOk = afterEnglish.some((t) => t.includes(payload))
  if (!englishOk) problems.push(`英文没有进输入框：期望包含 ${payload}`)

  // 3. 测试特殊字符（空格、符号）
  await evaluate(`window.desktop.sendText(${JSON.stringify(DEVICE)}, "a b@c.d")`)
  await new Promise((r) => setTimeout(r, 1500))
  const afterSpecial = readEditTexts()
  console.log('发送特殊字符后:', JSON.stringify(afterSpecial))
  const specialOk = afterSpecial.some((t) => t.includes('a b@c.d'))
  if (!specialOk) problems.push('特殊字符（空格/@/.）没有正确输入')

  // 4. 测试退格键
  await evaluate(`window.desktop.sendEditKey(${JSON.stringify(DEVICE)}, "backspace")`)
  await new Promise((r) => setTimeout(r, 1200))
  const afterBackspace = readEditTexts()
  console.log('退格后:', JSON.stringify(afterBackspace))
  const backspaceOk = !afterBackspace.some((t) => t.endsWith('d'))
  if (!backspaceOk) problems.push('退格键没有生效')

  // 5. 验证中文被正确拦截（不应该静默失败）
  let chineseRejected = false
  try {
    await evaluate(`window.desktop.sendText(${JSON.stringify(DEVICE)}, "中文")`)
  } catch (err) {
    chineseRejected = true
    console.log('中文被正确拦截:', String(err).slice(0, 80))
  }
  if (!chineseRejected) problems.push('中文文本应当被拦截并报错，而不是静默失败')

  ws.close()

  if (problems.length) {
    console.error('\n❌ 存在问题：\n - ' + problems.join('\n - '))
    process.exit(1)
  }
  console.log('\n✅ 键盘输入验证通过：英文、特殊字符、退格、中文拦截都正常')
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
