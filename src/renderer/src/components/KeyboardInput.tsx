import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditKey } from '@shared/types'

interface KeyboardInputProps {
  deviceId: string | null
  /** 是否允许输入（投屏中且设备在线） */
  enabled: boolean
  /** 捕获状态变化时回调（App 用来决定手势热键是否让路） */
  onCapturingChange?(capturing: boolean): void
}

/** 电脑上按下的特殊键到手机编辑键的映射 */
const KEY_TO_EDIT: Record<string, EditKey> = {
  Enter: 'enter',
  Backspace: 'backspace',
  Delete: 'delete',
  Tab: 'tab',
  Escape: 'escape',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end'
}

const EDIT_BUTTONS: [EditKey, string][] = [
  ['enter', '回车'],
  ['backspace', '退格'],
  ['tab', 'Tab'],
  ['left', '←'],
  ['right', '→'],
  ['escape', 'Esc']
]

/** 判断字符能否用 input text 发送 */
function isAsciiChar(ch: string): boolean {
  return ch.length === 1 && ch >= ' ' && ch <= '~'
}

/**
 * 键盘输入面板。
 *
 * 只走 `adb shell input text` 这一条路径：不需要往手机装任何东西，
 * 也不会动用户的输入法设置。代价是只能输入英文、数字和符号。
 *
 * 中文没法从电脑注入：Android 的 `input text` 遇到非 ASCII 会直接让设备端
 * 抛 NullPointerException，而其他通道（剪贴板、unicode keyevent）实测都走不通，
 * 唯一可行的 ADBKeyboard 方案必须劫持手机输入法，体验太差已经放弃。
 * 所以这里明确提示用户用手机自己的输入法打中文。
 */
export function KeyboardInput({ deviceId, enabled, onCapturingChange }: KeyboardInputProps) {
  const [capturing, setCapturing] = useState(false)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    onCapturingChange?.(capturing)
  }, [capturing, onCapturingChange])

  /** 待发送的字符队列 */
  const queueRef = useRef<string[]>([])
  const sendingRef = useRef(false)

  /**
   * 顺序发送队列里的字符。
   *
   * 连续的可打印字符合并成一批发送，减少 adb 往返次数；
   * 遇到中文等非 ASCII 字符时丢弃并提示，避免静默丢字。
   */
  const flush = useCallback(async () => {
    if (sendingRef.current || !deviceId) return
    sendingRef.current = true
    try {
      while (queueRef.current.length > 0) {
        const batch: string[] = []
        let hitNonAscii = false

        while (queueRef.current.length > 0) {
          const ch = queueRef.current[0]
          if (isAsciiChar(ch)) {
            batch.push(ch)
            queueRef.current.shift()
          } else {
            queueRef.current.shift()
            hitNonAscii = true
            break
          }
        }

        if (batch.length > 0) {
          await window.desktop.sendText(deviceId, batch.join(''))
        }
        if (hitNonAscii) {
          setMessage('中文无法从电脑输入，请在手机上用输入法输入')
        }
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      queueRef.current = []
    } finally {
      sendingRef.current = false
    }
  }, [deviceId])

  const enqueue = useCallback(
    (text: string) => {
      queueRef.current.push(...[...text])
      void flush()
    },
    [flush]
  )

  const sendKey = useCallback(
    async (key: EditKey) => {
      if (!deviceId) return
      try {
        await window.desktop.sendEditKey(deviceId, key)
      } catch (err) {
        setMessage(err instanceof Error ? err.message : String(err))
      }
    },
    [deviceId]
  )

  // 捕获模式下拦截电脑键盘，转发给手机
  useEffect(() => {
    if (!capturing || !enabled) return

    const onKeyDown = (e: KeyboardEvent) => {
      // 输入框里打字时不拦截，让它正常编辑自己的内容
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      const edit = KEY_TO_EDIT[e.key]
      if (edit) {
        e.preventDefault()
        void sendKey(edit)
        return
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        enqueue(e.key)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [capturing, enabled, enqueue, sendKey])

  const sendDraft = useCallback(async () => {
    if (!deviceId || !draft) return
    try {
      await window.desktop.sendText(deviceId, draft)
      setDraft('')
      setMessage(null)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      setMessage(text.includes('非 ASCII') ? '这里只能发送英文、数字和符号，中文请在手机上输入' : text)
    }
  }, [deviceId, draft])

  const hasNonAscii = [...draft].some((ch) => !isAsciiChar(ch))

  return (
    <div className="space-y-2 border-t border-white/10 px-3 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">键盘输入</span>
        <button
          className={`rounded px-2 py-0.5 text-[11px] ${
            capturing ? 'bg-sky-600 text-white' : 'bg-white/10 text-slate-300 hover:bg-white/20'
          } disabled:opacity-40`}
          disabled={!enabled}
          onClick={() => setCapturing((v) => !v)}
        >
          {capturing ? '捕获中，点击停止' : '开始打字'}
        </button>
      </div>

      {capturing && enabled && (
        <p className="rounded bg-sky-950/60 px-2 py-1 text-[11px] leading-relaxed text-sky-200">
          现在直接在电脑上打字即可输入到手机（英文、数字、符号）。
        </p>
      )}

      <div className="flex gap-1">
        <input
          className="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-500"
          placeholder="输入英文后回车发送"
          value={draft}
          disabled={!enabled}
          onChange={(e) => {
            setDraft(e.target.value)
            setMessage(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void sendDraft()
            }
          }}
        />
        <button
          className="rounded bg-emerald-600 px-2 py-1 text-xs hover:bg-emerald-500 disabled:opacity-40"
          disabled={!enabled || !draft}
          onClick={() => void sendDraft()}
        >
          发送
        </button>
      </div>

      <div className="flex flex-wrap gap-1">
        {EDIT_BUTTONS.map(([key, label]) => (
          <button
            key={key}
            className="rounded bg-white/10 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/20 disabled:opacity-40"
            disabled={!enabled}
            onClick={() => void sendKey(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {hasNonAscii && (
        <p className="text-[11px] leading-relaxed text-amber-300">
          这里只能发送英文、数字和符号。中文请在手机上用输入法输入——
          从电脑注入中文必须劫持手机输入法，会把你自己的输入法顶掉，所以没有启用。
        </p>
      )}

      {message && <p className="text-[11px] text-rose-300">{message}</p>}
    </div>
  )
}
