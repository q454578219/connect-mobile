/**
 * 核心逻辑自测：H.264 码流解析 + minicap 协议 + 坐标换算。
 *
 * 这几块最容易出「画面能出但点击偏了」或「帧拼错」的问题，用构造数据验证，
 * 不依赖真机和 Electron。跑法：pnpm test:unit
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AnnexBSplitter,
  FrameAssembler,
  NalType,
  buildAvcC,
  codecStringFromSps,
  parseSpsDimensions
} from '../src/main/h264.ts'
import { MinicapParser } from '../src/main/minicap-parser.ts'
import { toDevicePoint, scaleFor } from '../src/main/coords.ts'
import { isAsciiText, escapeForShell } from '../src/main/text-input.ts'
import {
  isWirelessId,
  parseMdnsServices,
  parseWlanIp,
  interpretConnectOutput,
  interpretPairOutput
} from '../src/main/wireless-parse.ts'

// ───────────── H.264 Annex-B 切分 ─────────────

/** 构造一个 NAL：起始码 + 头字节 + 载荷 */
function nal(type, payload = [0x11, 0x22]) {
  return Buffer.from([0, 0, 0, 1, type, ...payload])
}

test('切分 Annex-B：识别 SPS / PPS / IDR', () => {
  const sps = nal(NalType.SPS, [0x42, 0xc0, 0x29, 0x8d])
  const pps = nal(NalType.PPS, [0xce, 0x3c])
  const idr = nal(NalType.IDR_SLICE, [0x88, 0x84])
  const stream = Buffer.concat([sps, pps, idr])

  const splitter = new AnnexBSplitter()
  // 实时流里最后一个 NAL 会压在缓冲里，等下一个起始码才吐出来
  const units = splitter.push(new Uint8Array(stream))
  assert.equal(units.length, 2, '实时流不应提前吐出最后一个 NAL')

  // 数据源结束后用 flush 取出剩余部分
  const rest = splitter.flush()
  const all = [...units, ...rest]
  assert.equal(all.length, 3)
  assert.equal(all[0].type, NalType.SPS)
  assert.equal(all[1].type, NalType.PPS)
  assert.equal(all[2].type, NalType.IDR_SLICE)
  // NAL 头字节本身要保留（type 从低 5 位取）
  assert.equal(all[0].data[0], NalType.SPS)
})

test('切分 Annex-B：分片到达不会丢字节', () => {
  const stream = Buffer.concat([
    nal(NalType.SPS, [1, 2, 3, 4, 5]),
    nal(NalType.IDR_SLICE, [9, 8, 7, 6])
  ])
  const splitter = new AnnexBSplitter()
  const units = []
  // 逐字节喂，模拟最极端的碎片化
  for (let i = 0; i < stream.length; i++) {
    units.push(...splitter.push(stream.subarray(i, i + 1)))
  }
  units.push(...splitter.flush())
  assert.equal(units.length, 2)
  assert.deepEqual([...units[0].data], [NalType.SPS, 1, 2, 3, 4, 5])
  assert.deepEqual([...units[1].data], [NalType.IDR_SLICE, 9, 8, 7, 6])
})

test('切分 Annex-B：3 字节起始码同样支持', () => {
  const stream = Buffer.from([0, 0, 1, 0x67, 0xaa, 0, 0, 1, 0x68, 0xbb])
  const splitter = new AnnexBSplitter()
  const units = splitter.push(new Uint8Array(stream))
  units.push(...splitter.flush())
  assert.equal(units.length, 2)
  assert.equal(units[0].type, NalType.SPS)
  assert.equal(units[1].type, NalType.PPS)
})

test('切分 Annex-B：起始码后没有任何载荷时不吐 NAL', () => {
  const splitter = new AnnexBSplitter()
  // 只有起始码，没有 NAL 头也没有载荷
  const units = splitter.push(new Uint8Array([0, 0, 1]))
  assert.equal(units.length, 0)
  assert.equal(splitter.flush().length, 0, 'flush 也不应吐出空 NAL')
})

// ───────────── 帧组装 ─────────────

test('帧组装：每个 VCL 切片构成一帧', () => {
  const assembler = new FrameAssembler()
  const splitter = new AnnexBSplitter()
  const frames = []

  // 参数集 + 关键帧；末尾再跟一个 P 帧的起始码，把 IDR 顶出来
  const head = Buffer.concat([
    nal(NalType.SPS, [0x67, 0x42, 0xc0, 0x29, 0x8d, 0x68]),
    nal(NalType.PPS, [0x68, 0xce, 0x3c]),
    nal(NalType.IDR_SLICE, [0x65, 1, 1]),
    nal(NalType.NON_IDR_SLICE, [0x41, 2, 2]),
    nal(NalType.NON_IDR_SLICE, [0x41, 3, 3])
  ])
  frames.push(...assembler.push(splitter.push(new Uint8Array(head))).frames)
  // 数据源在这里结束，把最后一个 NAL 和最后一帧都吐出来
  frames.push(...assembler.push(splitter.flush()).frames)
  frames.push(...assembler.finish())

  assert.equal(frames.length, 3, `应组装出 3 帧，实际 ${frames.length}`)
  assert.equal(frames[0].keyframe, true, '第一帧应是关键帧')
  assert.equal(frames[1].keyframe, false)
  assert.equal(frames[2].keyframe, false)
})

test('帧组装：参数集不进帧数据，只用于生成配置', () => {
  const assembler = new FrameAssembler()
  const splitter = new AnnexBSplitter()

  // nal() 会自动带上 NAL 头字节，这里传的是载荷
  const sps = nal(NalType.SPS, [0x42, 0xc0, 0x29, 0x8d, 0x68])
  const pps = nal(NalType.PPS, [0xce, 0x3c, 0x80])
  const idr = nal(NalType.IDR_SLICE, [0x88, 0x84, 0x00, 0x33])

  assembler.push(splitter.push(new Uint8Array(Buffer.concat([sps, pps]))))
  const frames = assembler.push(splitter.push(new Uint8Array(idr))).frames
  frames.push(...assembler.push(splitter.flush()).frames)
  frames.push(...assembler.finish())

  assert.equal(frames.length, 1)
  const d = frames[0].data
  // AVCC：4 字节长度 + NAL
  const len = ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3]
  assert.equal(len, d.length - 4, '长度前缀应等于后续数据长度')
  assert.equal(d[4] & 0x1f, NalType.IDR_SLICE, '帧数据里应是切片而不是参数集')

  const config = assembler.getConfig()
  assert.ok(config, '应能生成解码配置')
  assert.equal(config.codec, 'avc1.42c029', `codec 应为 avc1.42c029，实际 ${config.codec}`)
})

// ───────────── avcC 与 codec 字符串 ─────────────

test('avcC 结构符合规范', () => {
  const sps = Buffer.from([0x67, 0x42, 0xc0, 0x29, 0x8d, 0x68])
  const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80])
  const avcC = buildAvcC(new Uint8Array(sps), new Uint8Array(pps))

  assert.equal(avcC[0], 1, 'configurationVersion 必须是 1')
  assert.equal(avcC[1], 0x42, 'profile 取自 SPS')
  assert.equal(avcC[2], 0xc0, 'compatibility 取自 SPS')
  assert.equal(avcC[3], 0x29, 'level 取自 SPS')
  assert.equal(avcC[4], 0xff, '4 字节长度前缀标志')
  assert.equal(avcC[5], 0xe1, '1 个 SPS')
  assert.equal((avcC[6] << 8) + avcC[7], sps.length)
  const ppsCountOffset = 8 + sps.length
  assert.equal(avcC[ppsCountOffset], 1, '1 个 PPS')
  assert.equal((avcC[ppsCountOffset + 1] << 8) + avcC[ppsCountOffset + 2], pps.length)
})

test('codec 字符串格式正确', () => {
  const sps = Buffer.from([0x67, 0x42, 0xc0, 0x29])
  assert.equal(codecStringFromSps(new Uint8Array(sps)), 'avc1.42c029')
})

// ───────────── SPS 分辨率解析 ─────────────

test('从真实 SPS 解析出 720x1560', () => {
  // 来自模拟器 screenrecord 的真实 SPS NAL
  const sps = Buffer.from([
    0x67, 0x42, 0xc0, 0x29, 0x8d, 0x68, 0x0b, 0x40, 0xc5, 0xf9, 0x64, 0x20, 0x00, 0x00, 0x03,
    0x00, 0xf0, 0x88, 0x46, 0xa0
  ])
  const dims = parseSpsDimensions(new Uint8Array(sps))
  assert.deepEqual(dims, { width: 720, height: 1560 })
})

test('SPS 数据损坏时返回 null 而不是抛异常', () => {
  assert.equal(parseSpsDimensions(new Uint8Array([])), null)
  assert.equal(parseSpsDimensions(new Uint8Array([0x67])), null)
})

// ───────────── minicap 协议（旧系统回退） ─────────────

function buildHeader({ realW, realH, virtualW, virtualH }) {
  const buf = Buffer.alloc(24)
  buf.writeUInt8(1, 0)
  buf.writeUInt8(24, 2)
  buf.writeUInt32LE(1234, 3)
  buf.writeUInt32LE(realW, 7)
  buf.writeUInt32LE(realH, 11)
  buf.writeUInt32LE(virtualW, 15)
  buf.writeUInt32LE(virtualH, 19)
  return buf
}

function buildJpegFrame(payload) {
  const head = Buffer.alloc(4)
  head.writeUInt32LE(payload.length, 0)
  return Buffer.concat([head, payload])
}

test('minicap：解析头与单帧', () => {
  const frames = []
  const parser = new MinicapParser((f) => frames.push(f))
  const jpeg = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9])
  parser.push(
    Buffer.concat([buildHeader({ realW: 1080, realH: 2400, virtualW: 720, virtualH: 1600 }), buildJpegFrame(jpeg)])
  )
  assert.equal(parser.width, 1080)
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].jpeg, jpeg)
  assert.equal(frames[0].width, 720)
})

test('minicap：分片到达能正确拼帧', () => {
  const frames = []
  const parser = new MinicapParser((f) => frames.push(f))
  const jpeg = Buffer.alloc(500, 0xab)
  const stream = Buffer.concat([
    buildHeader({ realW: 720, realH: 1280, virtualW: 720, virtualH: 1280 }),
    buildJpegFrame(jpeg)
  ])
  for (let i = 0; i < stream.length; i += 7) {
    parser.push(stream.subarray(i, Math.min(i + 7, stream.length)))
  }
  assert.equal(frames.length, 1)
  assert.equal(frames[0].jpeg.length, 500)
})

test('minicap：协议版本不符要报错', () => {
  const parser = new MinicapParser(() => {})
  const bad = buildHeader({ realW: 1, realH: 1, virtualW: 1, virtualH: 1 })
  bad.writeUInt8(2, 0)
  assert.throws(() => parser.push(bad), /不支持的 minicap 协议版本/)
})

// ───────────── 坐标换算 ─────────────

test('画面与屏幕同尺寸时原样透传', () => {
  const size = { width: 1080, height: 2400 }
  assert.deepEqual(toDevicePoint({ x: 540, y: 1200 }, size, size, false), { x: 540, y: 1200 })
})

test('画面缩小后要放大回设备坐标（真机 1440 屏出 720 画面）', () => {
  const frame = { width: 720, height: 1600 }
  const screen = { width: 1440, height: 3200 }
  // 画面正中心 → 设备正中心
  assert.deepEqual(toDevicePoint({ x: 360, y: 800 }, frame, screen, false), { x: 720, y: 1600 })
  // 画面右下角 → 设备右下角（受 -1 边界约束）
  assert.deepEqual(toDevicePoint({ x: 720, y: 1600 }, frame, screen, false), {
    x: 1439,
    y: 3199
  })
  // 四分之一位置
  assert.deepEqual(toDevicePoint({ x: 180, y: 400 }, frame, screen, false), { x: 360, y: 800 })
})

test('缩放比例计算正确', () => {
  assert.deepEqual(scaleFor({ width: 720, height: 1600 }, { width: 1440, height: 3200 }, false), {
    scaleX: 2,
    scaleY: 2
  })
  // 横屏：画面 1600x720，屏幕 1440x3200 旋转后显示区 3200x1440
  assert.deepEqual(scaleFor({ width: 1600, height: 720 }, { width: 1440, height: 3200 }, true), {
    scaleX: 2,
    scaleY: 2
  })
})

test('横屏时按交换后的屏幕尺寸换算', () => {
  const frame = { width: 1600, height: 720 }
  const screen = { width: 1440, height: 3200 }
  // 横屏下显示区是 3200x1440
  assert.deepEqual(toDevicePoint({ x: 800, y: 360 }, frame, screen, true), {
    x: 1600,
    y: 720
  })
})

test('超出范围被裁剪到屏幕内', () => {
  const frame = { width: 720, height: 1600 }
  const screen = { width: 1440, height: 3200 }
  assert.deepEqual(toDevicePoint({ x: 5000, y: 5000 }, frame, screen, false), {
    x: 1439,
    y: 3199
  })
  assert.deepEqual(toDevicePoint({ x: -30, y: -8 }, frame, screen, false), { x: 0, y: 0 })
})

// ───────────── 键盘输入 ─────────────

test('ASCII 判定：只放行可打印字符', () => {
  assert.equal(isAsciiText('abc'), true)
  assert.equal(isAsciiText('ABC123'), true)
  assert.equal(isAsciiText('hello world'), true)
  assert.equal(isAsciiText('a@b.com'), true)
  assert.equal(isAsciiText('!@#$%^&*()'), true)
  assert.equal(isAsciiText(''), true)

  // 中文会让设备端 input text 直接崩，必须拦下来
  assert.equal(isAsciiText('中文'), false)
  assert.equal(isAsciiText('hello世界'), false)
  // 带重音的字符同样不是 ASCII
  assert.equal(isAsciiText('héllo'), false)
})

test('shell 转义：空格换成 %s', () => {
  assert.equal(escapeForShell('hello world'), 'hello%sworld')
  assert.equal(escapeForShell('a  b'), 'a%s%sb')
})

test('shell 转义：元字符不会被 shell 解释', () => {
  assert.equal(escapeForShell('a&b'), 'a\\&b')
  assert.equal(escapeForShell('a|b'), 'a\\|b')
  assert.equal(escapeForShell('a;b'), 'a\\;b')
  assert.equal(escapeForShell('$HOME'), '\\$HOME')
  assert.equal(escapeForShell('a"b'), 'a\\"b')
  assert.equal(escapeForShell("a'b"), "a\\'b")
})

test('shell 转义：普通文本保持不变', () => {
  assert.equal(escapeForShell('abc123'), 'abc123')
  assert.equal(escapeForShell('hello.txt'), 'hello.txt')
})

// ───────────── 无线连接解析 ─────────────

test('无线序列号判定：ip:port 是无线，USB 序列号不是', () => {
  assert.equal(isWirelessId('192.168.31.23:5555'), true)
  assert.equal(isWirelessId('10.0.0.1:41337'), true)
  assert.equal(isWirelessId('adb-30E6JQDPN.8H2KTG-xxxxxx._adb-tls-connect._tcp.'), false)
  assert.equal(isWirelessId('emulator-5554'), false)
  assert.equal(isWirelessId('1A2B3C4D5E6F7G'), false)
  assert.equal(isWirelessId(''), false)
})

test('解析 mdns 输出：connect 与 pairing 服务分开', () => {
  const raw = [
    'There are 2 services:',
    '\tabd-30E6JQDPN.8H2KTG._adb-tls-connect._tcp.\t192.168.31.23:37913',
    '\tabd-30E6JQDPN.8H2KTG._adb-tls-pairing._tcp.\t192.168.31.23:41235'
  ].join('\n')
  const services = parseMdnsServices(raw)
  assert.equal(services.length, 2)
  assert.deepEqual(
    { kind: services[0].kind, ip: services[0].ip, port: services[0].port },
    { kind: 'connect', ip: '192.168.31.23', port: 37913 }
  )
  assert.equal(services[1].kind, 'pair')
  assert.equal(services[1].port, 41235)
})

test('解析 mdns 输出：空结果与无关行', () => {
  assert.deepEqual(parseMdnsServices(''), [])
  assert.deepEqual(parseMdnsServices('There are 0 services:'), [])
  assert.deepEqual(parseMdnsServices('foo bar 192.168.1.1:22\nno type here'), [])
})

test('解析 mdns 输出：重复服务去重、ip:port 用空格分隔也能解析', () => {
  const raw = [
    '\tabd-a._adb-tls-connect._tcp.\t192.168.1.5:1111',
    'ab another 192.168.1.5:1111 _adb-tls-connect._tcp.',
    '\tabd-b._adb-tls-pairing._tcp. 192.168.1.5:2222'
  ].join('\n')
  const services = parseMdnsServices(raw)
  assert.equal(services.length, 2)
  assert.equal(services.filter((s) => s.kind === 'connect').length, 1)
})

test('从 ip addr / ip route 输出提取手机 WiFi IP', () => {
  const addr = [
    '30: wlan0    inet 192.168.31.23/24 brd 192.168.31.255 scope global wlan0',
    '    valid_lft forever preferred_lft forever'
  ].join('\n')
  assert.equal(parseWlanIp(addr), '192.168.31.23')

  const route = '192.168.31.0/24 dev wlan0 proto kernel scope link src 192.168.31.23'
  assert.equal(parseWlanIp('', route), '192.168.31.23')
  // 回环地址不算
  assert.equal(parseWlanIp('inet 127.0.0.1/8 scope host lo', ''), null)
  assert.equal(parseWlanIp('', ''), null)
})

test('connect 输出分类：成功/已连接/失败给可读原因', () => {
  assert.equal(interpretConnectOutput('connected to 192.168.31.23:5555').ok, true)
  assert.equal(interpretConnectOutput('already connected to 192.168.31.23:5555').ok, true)
  assert.equal(interpretConnectOutput('failed to connect to 192.168.31.23:5555').ok, false)
  assert.match(interpretConnectOutput('failed to connect to 1.2.3.4:5555').message, /无线调试/)
  assert.equal(interpretConnectOutput('cannot connect to 1.2.3.4:5555: Connection refused').ok, false)
  assert.equal(interpretConnectOutput('').ok, false)
})

test('pair 输出分类：Success / 失败', () => {
  assert.equal(interpretPairOutput('Success pairing with 192.168.1.5:41235').ok, true)
  const bad = interpretPairOutput('Failed to pair with 192.168.1.5:41235')
  assert.equal(bad.ok, false)
  assert.match(bad.message, /配对/)
})
