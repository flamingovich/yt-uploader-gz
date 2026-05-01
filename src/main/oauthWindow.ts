import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ProxyRow } from '@services/db/types'

function toProxyRule(proxy?: ProxyRow | null): string {
  if (!proxy) return ''
  const host = proxy.host.trim()
  const login = proxy.login?.trim()
  const password = proxy.password ?? ''
  if (login && password !== '') {
    return `socks5://${encodeURIComponent(login)}:${encodeURIComponent(password)}@${host}:${proxy.port}`
  }
  if (login) {
    return `socks5://${encodeURIComponent(login)}@${host}:${proxy.port}`
  }
  return `socks5://${host}:${proxy.port}`
}

/**
 * Открывает OAuth только во встроенном изолированном окне Electron (не системный браузер).
 * Сессия in-memory, без persist, с опциональным SOCKS5-прокси канала.
 */
export async function openOAuthInAppWindow(input: {
  url: string
  proxy?: ProxyRow | null
}): Promise<{ close: () => void }> {
  const partition = `oauth-${randomUUID()}`
  const ses = session.fromPartition(partition, { cache: false })

  if (input.proxy) {
    await ses.setProxy({ proxyRules: toProxyRule(input.proxy) })
  }

  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)

  const win = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 840,
    minHeight: 640,
    backgroundColor: '#0f0f0f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false
    }
  })

  if (input.proxy?.login) {
    win.webContents.on('login', (event, _details, authInfo, callback) => {
      if (!authInfo.isProxy) return
      event.preventDefault()
      callback(input.proxy?.login ?? '', input.proxy?.password ?? '')
    })
  }

  win.on('closed', () => {
    void ses.clearCache()
    void ses.clearStorageData()
  })

  const loadPromise = new Promise<void>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    win.webContents.once('did-finish-load', () => done(() => resolve()))
    win.webContents.once('did-fail-load', (_event, errorCode, errorDescription) =>
      done(() => reject(new Error(`OAuth окно не загрузилось: ${errorDescription} (${errorCode})`)))
    )
  })

  try {
    await Promise.all([loadPromise, win.loadURL(input.url)])
    if (!win.isDestroyed()) {
      win.show()
    }
  } catch (e) {
    if (!win.isDestroyed()) {
      win.close()
    }
    throw e
  }
  return { close: () => win.close() }
}
