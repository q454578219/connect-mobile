import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

export type MaskMode = 'off' | 'night' | 'eye' | 'custom'

export interface MaskConfig {
  mode: MaskMode
  /** 自定义模式的色调（hex） */
  color: string
  /** 色调层深浅 0~1 */
  opacity: number
  /** 额外压暗 0~1（黑色层，所有模式可用） */
  dim: number
  /** 作用范围：picture = 只盖画面区域；window = 盖满整个窗口（含侧栏/工具条） */
  scope: 'picture' | 'window'
}

export const DEFAULT_MASK: MaskConfig = {
  mode: 'off',
  color: '#ff9b3f',
  opacity: 0.5,
  dim: 0,
  scope: 'picture'
}

/** 当前模式的遮罩层样式（按 DOM 顺序叠加，压暗层永远在最上） */
export function maskLayers(cfg: MaskConfig): CSSProperties[] {
  const layers: CSSProperties[] = []
  if (cfg.mode === 'night') {
    // 暖橙 + multiply：压掉冷色高光，夜里有暖色滤光片的感觉
    layers.push({ background: '#ff9b3f', mixBlendMode: 'multiply', opacity: cfg.opacity })
  } else if (cfg.mode === 'eye') {
    layers.push({ background: '#b7e6b0', opacity: cfg.opacity })
  } else if (cfg.mode === 'custom') {
    layers.push({ background: cfg.color, opacity: cfg.opacity })
  }
  if (cfg.dim > 0) {
    layers.push({ background: '#000000', opacity: cfg.dim })
  }
  return layers
}

/** 盖在画面上的遮罩层：pointer-events 关闭，不影响点击/滚轮。
 *  scope='window' 时用 fixed 定位盖满整个窗口（含菜单栏/侧栏/工具条）。 */
export function ColorMaskOverlay({ config }: { config: MaskConfig }) {
  const layers = maskLayers(config)
  if (layers.length === 0) return null
  const scopeClass = config.scope === 'window' ? 'fixed inset-0 z-40' : 'absolute inset-0'
  return (
    <div className={`pointer-events-none ${scopeClass}`}>
      {layers.map((style, i) => (
        <div key={i} className="absolute inset-0" style={style} />
      ))}
    </div>
  )
}

const MODES: { key: MaskMode; label: string; desc: string }[] = [
  { key: 'off', label: '关闭', desc: '原始画面' },
  { key: 'night', label: '黑夜模式', desc: '暖橙压暗，适合夜里/暗环境' },
  { key: 'eye', label: '护眼模式', desc: '淡绿色调，长时间看舒服些' },
  { key: 'custom', label: '自定义', desc: '任意色调' }
]

interface ColorMaskButtonProps {
  config: MaskConfig
  disabled?: boolean
  /** 紧凑模式：只显示图标不显示文字 */
  compact?: boolean
  onChange(config: MaskConfig): void
}

/** 底部工具条的遮罩入口：按钮 + 向上弹出的设置面板 */
export function ColorMaskButton({ config, disabled, compact, onChange }: ColorMaskButtonProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 点面板外面收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const active = config.mode !== 'off' || config.dim > 0

  return (
    <div className="relative" ref={rootRef}>
      <button
        title="遮罩：给画面加夜间/护眼/自定义色调，只影响电脑显示"
        className={`flex h-9 shrink-0 items-center gap-1 rounded-lg px-3 text-xs disabled:opacity-30 ${
          active
            ? 'bg-indigo-600/80 text-white hover:bg-indigo-500'
            : 'bg-white/10 text-slate-200 hover:bg-white/20'
        }`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span>🌓</span>
        <span className={compact ? 'hidden' : ''}>遮罩</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 z-30 mb-2 w-64 -translate-x-1/2 space-y-3 rounded-lg border border-white/10 bg-slate-900 p-3 text-xs shadow-2xl">
          <div className="grid grid-cols-2 gap-1">
            {MODES.map((m) => (
              <button
                key={m.key}
                title={m.desc}
                className={`rounded px-2 py-1.5 ${
                  config.mode === m.key
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white/10 text-slate-200 hover:bg-white/20'
                }`}
                onClick={() => onChange({ ...config, mode: m.key })}
              >
                {m.label}
              </button>
            ))}
          </div>

          {config.mode === 'custom' && (
            <label className="flex items-center justify-between text-slate-300">
              色调
              <input
                type="color"
                className="h-7 w-16 cursor-pointer rounded border border-white/10 bg-transparent"
                value={config.color}
                onChange={(e) => onChange({ ...config, color: e.target.value })}
              />
            </label>
          )}

          {config.mode !== 'off' && (
            <div className="flex items-center justify-between text-slate-300">
              <span>作用范围</span>
              <div className="flex gap-1">
                <button
                  className={`rounded px-2 py-1 ${
                    config.scope === 'picture'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white/10 text-slate-200 hover:bg-white/20'
                  }`}
                  onClick={() => onChange({ ...config, scope: 'picture' })}
                >
                  仅画面
                </button>
                <button
                  className={`rounded px-2 py-1 ${
                    config.scope === 'window'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white/10 text-slate-200 hover:bg-white/20'
                  }`}
                  onClick={() => onChange({ ...config, scope: 'window' })}
                >
                  整个窗口
                </button>
              </div>
            </div>
          )}

          {config.mode !== 'off' && (
            <label className="block space-y-1 text-slate-300">
              <span>色调深浅 {Math.round(config.opacity * 100)}%</span>
              <input
                type="range"
                min={0}
                max={90}
                value={Math.round(config.opacity * 100)}
                className="w-full accent-indigo-500"
                onChange={(e) => onChange({ ...config, opacity: Number(e.target.value) / 100 })}
              />
            </label>
          )}

          <label className="block space-y-1 text-slate-300">
            <span>压暗 {Math.round(config.dim * 100)}%</span>
            <input
              type="range"
              min={0}
              max={80}
              value={Math.round(config.dim * 100)}
              className="w-full accent-indigo-500"
              onChange={(e) => onChange({ ...config, dim: Number(e.target.value) / 100 })}
            />
          </label>

          <p className="text-[11px] leading-relaxed text-slate-500">
            遮罩只影响电脑上的显示，手机画面不受影响；点击、滑动照常可用。「整个窗口」会把侧栏和工具条也染色。
          </p>
        </div>
      )}
    </div>
  )
}
