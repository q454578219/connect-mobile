/**
 * 用真实 screenrecord 数据验证 H.264 解析链路：
 *   Annex-B 切分 → 收集 SPS/PPS → 帧组装 → avcC / codec 字符串
 *
 * 数据来源：模拟器上 `screenrecord --output-format=h264 -` 的真实输出。
 * Node 22 自带类型剥离，可以直接 import .ts。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AnnexBSplitter,
  FrameAssembler,
  NalType
} from '../src/main/h264.ts'

const here = dirname(fileURLToPath(import.meta.url))

const h264Path = process.argv[2] ?? join(process.env.TEMP, 'sr.h264')
if (!existsSync(h264Path)) {
  console.error('找不到 H.264 样本：', h264Path)
  process.exit(1)
}

const raw = new Uint8Array(readFileSync(h264Path))
console.log(`样本大小：${raw.length} 字节`)

const splitter = new AnnexBSplitter()
const assembler = new FrameAssembler()

// 模拟真实网络分片：每 1500 字节推一次
const allFrames = []
const types = new Set()
let config = null

for (let i = 0; i < raw.length; i += 1500) {
  const chunk = raw.subarray(i, Math.min(i + 1500, raw.length))
  const units = splitter.push(chunk)
  for (const u of units) types.add(u.type)
  const { frames } = assembler.push(units)
  allFrames.push(...frames)
  if (!config) config = assembler.getConfig()
}
allFrames.push(...assembler.finish())
if (!config) config = assembler.getConfig()

console.log('NAL 类型：', [...types].sort((a, b) => a - b))
console.log(
  '解码配置：',
  config ? { codec: config.codec, w: config.width, h: config.height, avcC: config.avcC.length } : null
)
console.log('组装出帧数：', allFrames.length)
console.log('关键帧数：', allFrames.filter((f) => f.keyframe).length)
if (allFrames.length) {
  console.log('首帧字节数：', allFrames[0].data.length, ' keyframe=', allFrames[0].keyframe)
}

const problems = []
if (!types.has(NalType.SPS)) problems.push('没有解析到 SPS')
if (!types.has(NalType.PPS)) problems.push('没有解析到 PPS')
if (!types.has(NalType.IDR_SLICE)) problems.push('没有解析到 IDR 关键帧')
if (!config) problems.push('没有生成解码配置')
if (allFrames.length < 3) problems.push(`组装帧数过少：${allFrames.length}`)
// 期望尺寸可由第二个参数指定，默认按 720x1560 的样本
const expectW = Number(process.argv[3] ?? 720)
const expectH = Number(process.argv[4] ?? 1560)
if (config && (config.width !== expectW || config.height !== expectH)) {
  problems.push(`SPS 解析尺寸不对：${config.width}x${config.height}（期望 ${expectW}x${expectH}）`)
}
if (allFrames.length) {
  const d = allFrames[0].data
  // AVCC 格式：前 4 字节是大端长度，后面紧跟 NAL；长度 = 总长 - 4
  const len = ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3]
  if (len !== d.length - 4) {
    problems.push(`首帧 AVCC 长度前缀不对：前缀 ${len}，实际 ${d.length - 4}`)
  }
  // 第一段 NAL 的类型应当是非 IDR(1) 或 IDR(5)
  const firstNalType = d[4] & 0x1f
  if (firstNalType !== 1 && firstNalType !== 5) {
    problems.push(`首帧第一个 NAL 类型异常：${firstNalType}`)
  }
}

if (problems.length) {
  console.error('\n❌ 失败：\n - ' + problems.join('\n - '))
  process.exit(1)
}
console.log('\n✅ H.264 解析链路验证通过')
