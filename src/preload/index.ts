import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopApi,
  DeviceInfo,
  EditKey,
  MainEvent,
  MdnsService,
  NavKey,
  SwipeAction,
  TouchPoint
} from '@shared/types'

const api: DesktopApi = {
  listDevices: (): Promise<DeviceInfo[]> => ipcRenderer.invoke('devices:list'),
  startStream: (deviceId: string, targetWidth?: number, preferFps?: boolean): Promise<void> =>
    ipcRenderer.invoke('stream:start', deviceId, targetWidth, preferFps),
  stopStream: (): Promise<void> => ipcRenderer.invoke('stream:stop'),
  tap: (deviceId: string, point: TouchPoint): Promise<void> =>
    ipcRenderer.invoke('input:tap', deviceId, point),
  swipe: (deviceId: string, action: SwipeAction): Promise<void> =>
    ipcRenderer.invoke('input:swipe', deviceId, action),
  pressKey: (deviceId: string, key: NavKey): Promise<void> =>
    ipcRenderer.invoke('input:key', deviceId, key),
  sendText: (deviceId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('input:text', deviceId, text),
  sendEditKey: (deviceId: string, key: EditKey): Promise<void> =>
    ipcRenderer.invoke('input:edit-key', deviceId, key),
  setScreenPower: (deviceId: string, on: boolean): Promise<void> =>
    ipcRenderer.invoke('screen-power:set', deviceId, on),
  wirelessScan: (): Promise<{ services: MdnsService[]; supported: boolean }> =>
    ipcRenderer.invoke('wireless:scan'),
  wirelessPair: (ip: string, port: number, code: string): Promise<void> =>
    ipcRenderer.invoke('wireless:pair', ip, port, code),
  wirelessConnect: (ip: string, port: number): Promise<string> =>
    ipcRenderer.invoke('wireless:connect', ip, port),
  wirelessDisconnect: (ip: string, port: number): Promise<void> =>
    ipcRenderer.invoke('wireless:disconnect', ip, port),
  wirelessFromUsb: (deviceId: string): Promise<string> =>
    ipcRenderer.invoke('wireless:from-usb', deviceId),
  compactWindow: (ratio: number | null): Promise<void> =>
    ipcRenderer.invoke('window:compact', ratio),
  onEvent: (listener: (event: MainEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: MainEvent): void => listener(event)
    ipcRenderer.on('main-event', handler)
    return () => ipcRenderer.removeListener('main-event', handler)
  }
}

contextBridge.exposeInMainWorld('desktop', api)
