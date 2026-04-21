import { getDefaultBaseUrl, setBaseUrl, setAuthToken } from '../api/client'

export const REMOTE_SERVER_URL_KEY = 'cc-haha-remote-server-url'
export const REMOTE_SERVER_TOKEN_KEY = 'cc-haha-remote-server-token'

export function isTauriRuntime() {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export function isRemoteMode() {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return false
  const remoteUrl = localStorage.getItem(REMOTE_SERVER_URL_KEY)
  return !!remoteUrl && remoteUrl.trim() !== ''
}

export async function initializeDesktopServerUrl() {
  // 1. Try remote server from localStorage first
  const remoteUrl = localStorage.getItem(REMOTE_SERVER_URL_KEY)
  const remoteToken = localStorage.getItem(REMOTE_SERVER_TOKEN_KEY)

  if (remoteUrl) {
    console.log('[desktop] Using remote server:', remoteUrl)
    setBaseUrl(remoteUrl)
    setAuthToken(remoteToken)
    // Validate health but don't fail hard if it's slow/down
    try {
      await waitForHealth(remoteUrl)
    } catch (e) {
      console.warn('[desktop] Remote server healthcheck failed:', e)
    }
    return remoteUrl
  }

  const fallbackUrl = getDefaultBaseUrl()

  if (!isTauriRuntime()) {
    setBaseUrl(fallbackUrl)
    return fallbackUrl
  }

  try {
    const { invoke } = await import(/* @vite-ignore */ '@tauri-apps/api/core')
    const serverUrl = await invoke<string>('get_server_url')
    setBaseUrl(serverUrl)
    await waitForHealth(serverUrl)
    return serverUrl
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `desktop server startup failed: ${String(error)}`
    console.error('[desktop] Failed to initialize desktop server URL', error)
    throw new Error(message || `desktop server startup failed (fallback would be ${fallbackUrl})`)
  }
}

async function waitForHealth(serverUrl: string) {
  let lastError: unknown

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${serverUrl}/health`, {
        cache: 'no-store',
      })
      if (response.ok) {
        return
      }
      lastError = new Error(`healthcheck returned ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(
    lastError instanceof Error
      ? `Local server healthcheck failed: ${lastError.message}`
      : 'Local server healthcheck failed',
  )
}
