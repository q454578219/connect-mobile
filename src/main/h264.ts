/**
 * H.264 Annex-B 码流处理。
 *
 * `adb exec-out screenrecord --output-format=h264 -` 输出的是 Annex-B 裸流：
 * 每个 NAL 单元前面带 `00 00 01` 或 `00 00 00 01` 起始码。
 *
 * 但 Chromium 的 WebCodecs 在配置里给了 description（avcC）之后，
 * 要求数据是 AVCC 格式（4 字节大端长度前缀），不接受起始码。
 * 所以这里做三件事：切 NAL、从 SPS/PPS 拼出 avcC、把帧数据转成 AVCC。
 */

/** NAL 单元类型 */
export const NalType = {
  /** 非 IDR 切片，普通视频帧 */
  NON_IDR_SLICE: 1,
  /** IDR 切片，关键帧 */
  IDR_SLICE: 5,
  /** 补充增强信息 */
  SEI: 6,
  /** 序列参数集 */
  SPS: 7,
  /** 图像参数集 */
  PPS: 8
} as const

export interface NalUnit {
  type: number
  /** 不含起始码的 NAL 内容 */
  data: Uint8Array
}

/**
 * 一个访问单元（对应一帧）。
 *
 * screenrecord 每帧前面会重复发 SPS/PPS，这些参数集不进 AVCC 数据，
 * 只从里面收一次去构建 avcC，帧数据只保留 VCL 切片。
 */
export interface AccessUnit {
  /** AVCC 格式的帧数据（每个 NAL 前缀 4 字节长度） */
  data: Uint8Array
  /** 是否关键帧（IDR） */
  keyframe: boolean
}

/** 从字节流里切出所有完整 NAL；不完整的尾部会留到下次再拼 */
export class AnnexBSplitter {
  private buffer: Uint8Array = new Uint8Array(0)

  /** 喂入新数据，返回切出来的完整 NAL */
  push(chunk: Uint8Array): NalUnit[] {
    this.buffer = concat(this.buffer, chunk)
    const units: NalUnit[] = []

    // 找出所有起始码位置，最后一个起始码之后的数据可能不完整，留到下次
    const starts: number[] = []
    let i = 0
    while (i + 2 < this.buffer.length) {
      if (this.buffer[i] === 0 && this.buffer[i + 1] === 0 && this.buffer[i + 2] === 1) {
        starts.push(i)
        i += 3
      } else {
        i++
      }
    }

    if (starts.length === 0) {
      // 还没看到起始码，只保留末尾 2 字节（可能是被截断的 00 00）
      if (this.buffer.length > 2) {
        this.buffer = this.buffer.subarray(this.buffer.length - 2).slice()
      }
      return units
    }

    for (let s = 0; s < starts.length - 1; s++) {
      const nalStart = starts[s] + 3
      let nalEnd = starts[s + 1]
      // 4 字节起始码会在前一个 NAL 尾部留下一个 0，去掉
      while (nalEnd > nalStart && this.buffer[nalEnd - 1] === 0) nalEnd--
      if (nalEnd > nalStart) {
        units.push({ type: this.buffer[nalStart] & 0x1f, data: this.buffer.slice(nalStart, nalEnd) })
      }
    }

    // 保留最后一个起始码之后的内容
    this.buffer = this.buffer.subarray(starts[starts.length - 1]).slice()
    return units
  }

  /**
   * 取出还压在缓冲里的最后一个 NAL。
   *
   * 实时流里不能随便调用：最后一段可能只收到一半，提前吐出会截断帧。
   * 只在数据源结束或明确知道不会再有后续数据时使用。
   */
  flush(): NalUnit[] {
    const buf = this.buffer
    this.buffer = new Uint8Array(0)
    if (buf.length < 4 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1) return []
    let end = buf.length
    while (end > 3 && buf[end - 1] === 0) end--
    if (end <= 3) return []
    return [{ type: buf[3] & 0x1f, data: buf.slice(3, end) }]
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** 按 4 字节大端长度前缀把若干 NAL 拼成 AVCC 数据 */
export function toAvcc(nalUnits: Uint8Array[]): Uint8Array {
  let total = 0
  for (const n of nalUnits) total += 4 + n.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const n of nalUnits) {
    const len = n.length
    out[offset++] = (len >>> 24) & 0xff
    out[offset++] = (len >>> 16) & 0xff
    out[offset++] = (len >>> 8) & 0xff
    out[offset++] = len & 0xff
    out.set(n, offset)
    offset += len
  }
  return out
}

/**
 * 用 SPS/PPS 构造 AVCDecoderConfigurationRecord（即 MP4 里的 avcC box 内容）。
 *
 * 结构：configurationVersion(1) AVCProfileIndication(1) profile_compatibility(1)
 *      AVCLevelIndication(1) 0xFF(1) 0xE1(1) spsLength(2) sps...
 *      0x01(1) ppsCount(1) ppsLength(2) pps...
 */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length)
  let p = 0
  out[p++] = 1
  out[p++] = sps[1] // AVCProfileIndication
  out[p++] = sps[2] // profile_compatibility
  out[p++] = sps[3] // AVCLevelIndication
  out[p++] = 0xff // 4 字节长度前缀
  out[p++] = 0xe1 // 有 1 个 SPS
  out[p++] = (sps.length >> 8) & 0xff
  out[p++] = sps.length & 0xff
  out.set(sps, p)
  p += sps.length
  out[p++] = 1 // 1 个 PPS
  out[p++] = (pps.length >> 8) & 0xff
  out[p++] = pps.length & 0xff
  out.set(pps, p)
  return out
}

/** 由 SPS 生成 WebCodecs 用的 codec 字符串，如 avc1.42c029 */
export function codecStringFromSps(sps: Uint8Array): string {
  const hex = [sps[1], sps[2], sps[3]]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `avc1.${hex}`
}

/**
 * 从 SPS 里解析编码分辨率。
 *
 * 传进来的 sps 是完整 NAL 单元，第 0 字节是 NAL 头（0x67），
 * 真正的 SPS 语法从第 1 字节开始，所以这里先跳过 NAL 头。
 * 只实现解析宽高必需的字段，其余按规范逐个读掉以保持位对齐。
 */
export function parseSpsDimensions(spsNal: Uint8Array): { width: number; height: number } | null {
  const sps = spsNal.subarray(1)
  let bitPos = 0
  const readBit = (): number => {
    const byte = sps[bitPos >> 3]
    if (byte === undefined) throw new Error('SPS 越界')
    const bit = (byte >> (7 - (bitPos & 7))) & 1
    bitPos++
    return bit
  }
  const readBits = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | readBit()
    return v
  }
  const readUe = (): number => {
    let zeros = 0
    while (readBit() === 0) {
      zeros++
      if (zeros > 32) throw new Error('SPS 指数哥伦布码异常')
    }
    if (zeros === 0) return 0
    return (1 << zeros) - 1 + readBits(zeros)
  }

  try {
    const profileIdc = readBits(8) // profile_idc
    readBits(8) // constraint flags
    readBits(8) // level_idc
    readUe() // seq_parameter_set_id

    // 高 profile 有额外字段
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 144].includes(profileIdc)) {
      const chromaFormat = readUe()
      if (chromaFormat === 3) readBit()
      readUe() // bit_depth_luma_minus8
      readUe() // bit_depth_chroma_minus8
      readBit() // qpprime_y_zero_transform_bypass_flag
      if (readBit() === 1) {
        // seq_scaling_matrix_present_flag
        const count = chromaFormat !== 3 ? 8 : 12
        for (let i = 0; i < count; i++) {
          if (readBit() === 1) {
            const size = i < 6 ? 16 : 64
            let last = 8
            let next = 8
            for (let j = 0; j < size; j++) {
              if (next !== 0) next = (last + readUe() + 256) % 256
              last = next === 0 ? last : next
            }
          }
        }
      }
    }

    readUe() // log2_max_frame_num_minus4
    const pocType = readUe()
    if (pocType === 0) {
      readUe() // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      readBit()
      readUe()
      readUe()
      const cycle = readUe()
      for (let i = 0; i < cycle; i++) readUe()
    }
    readUe() // max_num_ref_frames
    readBit() // gaps_in_frame_num_value_allowed_flag

    const widthMbs = readUe() + 1
    const heightMapUnits = readUe() + 1
    const frameMbsOnly = readBit()
    if (frameMbsOnly === 0) readBit() // mb_adaptive_frame_field_flag
    readBit() // direct_8x8_inference_flag

    let cropLeft = 0
    let cropRight = 0
    let cropTop = 0
    let cropBottom = 0
    if (readBit() === 1) {
      cropLeft = readUe()
      cropRight = readUe()
      cropTop = readUe()
      cropBottom = readUe()
    }

    const heightMbs = (2 - frameMbsOnly) * heightMapUnits
    const width = widthMbs * 16 - (cropLeft + cropRight) * 2
    const height = heightMbs * 16 - (cropTop + cropBottom) * 2
    if (width <= 0 || height <= 0) return null
    return { width, height }
  } catch {
    return null
  }
}

/**
 * 把连续的 NAL 组装成「按帧」的访问单元，并顺带收集参数集。
 *
 * screenrecord 不给时间戳，只能靠码流结构判断帧边界：
 * 一帧的画面数据（VCL 切片）遇到下一帧的第一个切片就结束。
 * 因此每收到一个新的 VCL 切片，就先把上一帧 flush 出去，
 * 这一帧则留到下一次调用（或调用 finish）时再输出。
 */
export class FrameAssembler {
  private pendingSlices: Uint8Array[] = []
  private pendingKeyframe = false
  private sps: Uint8Array | null = null
  private pps: Uint8Array | null = null
  /** 当前帧是否已收到过第一个切片（用于区分「同帧的多切片」与「新的一帧」） */
  private currentFrameFirstSliceSeen = false

  /** 喂入新 NAL，返回因此完成的帧 */
  push(units: NalUnit[]): { frames: AccessUnit[]; configChanged: boolean } {
    const frames: AccessUnit[] = []
    let configChanged = false

    for (const unit of units) {
      if (unit.type === NalType.SPS) {
        if (!this.sps || !equals(this.sps, unit.data)) {
          this.sps = unit.data.slice()
          configChanged = true
        }
        continue
      }
      if (unit.type === NalType.PPS) {
        if (!this.pps || !equals(this.pps, unit.data)) {
          this.pps = unit.data.slice()
          configChanged = true
        }
        continue
      }
      if (unit.type === NalType.IDR_SLICE || unit.type === NalType.NON_IDR_SLICE) {
        // 已经攒了切片，且这一帧的第一个切片已记录过：说明来了新的帧
        if (this.currentFrameFirstSliceSeen) {
          this.flushInto(frames)
        }
        if (this.pendingSlices.length === 0) {
          this.pendingKeyframe = unit.type === NalType.IDR_SLICE
        }
        this.pendingSlices.push(unit.data.slice())
        this.currentFrameFirstSliceSeen = true
        continue
      }
      // SEI / AUD 等其它 NAL 直接忽略
    }

    return { frames, configChanged }
  }

  /** 结束当前帧并推进结果 */
  flushInto(frames: AccessUnit[]): void {
    if (this.pendingSlices.length === 0) return
    frames.push({
      data: toAvcc(this.pendingSlices),
      keyframe: this.pendingKeyframe
    })
    this.pendingSlices = []
    this.pendingKeyframe = false
    this.currentFrameFirstSliceSeen = false
  }

  /** 码流结束时把最后一帧也吐出来 */
  finish(): AccessUnit[] {
    const frames: AccessUnit[] = []
    this.flushInto(frames)
    return frames
  }

  /** 取当前的解码器配置（SPS/PPS 都收到时才有） */
  getConfig(): { avcC: Uint8Array; codec: string; width?: number; height?: number } | null {
    if (!this.sps || !this.pps) return null
    const dims = parseSpsDimensions(this.sps)
    return {
      avcC: buildAvcC(this.sps, this.pps),
      codec: codecStringFromSps(this.sps),
      width: dims?.width,
      height: dims?.height
    }
  }
}

function equals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
