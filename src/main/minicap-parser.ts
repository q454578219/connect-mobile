/**
 * minicap 原始流解析。
 *
 * 单独成模块是为了让协议解析能被单元测试直接覆盖，不必依赖 Electron 或 adb。
 */

/** minicap 输出的每帧 JPEG，已从原始流里切好 */
export interface MinicapFrame {
  jpeg: Buffer
  width: number
  height: number
}

/**
 * minicap 原始流解析器。
 *
 * 连接建立后先收到 24 字节的头：
 *   0-1   version
 *   2     headerSize
 *   3-6   pid
 *   7-10  真实宽
 *   11-14 真实高
 *   15-18 虚拟宽
 *   19-22 虚拟高
 *   23    屏幕方向
 * 之后每帧是 4 字节小端长度 + 一个完整 JPEG。
 */
export class MinicapParser {
  private buffer: Buffer = Buffer.alloc(0)
  private headerParsed = false
  /** 真实分辨率 */
  width = 0
  height = 0
  /** 输出画面尺寸 */
  private frameWidth = 0
  private frameHeight = 0
  private readonly onFrame: (frame: MinicapFrame) => void

  constructor(onFrame: (frame: MinicapFrame) => void) {
    this.onFrame = onFrame
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    if (!this.headerParsed) {
      if (this.buffer.length < 24) return
      const version = this.buffer.readUInt8(0)
      if (version !== 1) throw new Error(`不支持的 minicap 协议版本：${version}`)
      const headerSize = this.buffer.readUInt8(2)
      this.width = this.buffer.readUInt32LE(7)
      this.height = this.buffer.readUInt32LE(11)
      this.frameWidth = this.buffer.readUInt32LE(15)
      this.frameHeight = this.buffer.readUInt32LE(19)
      this.headerParsed = true
      this.buffer = this.buffer.subarray(headerSize)
    }

    for (;;) {
      if (this.buffer.length < 4) return
      const size = this.buffer.readUInt32LE(0)
      if (this.buffer.length < 4 + size) return
      const jpeg = this.buffer.subarray(4, 4 + size)
      this.buffer = this.buffer.subarray(4 + size)
      this.onFrame({ jpeg: Buffer.from(jpeg), width: this.frameWidth, height: this.frameHeight })
    }
  }
}
