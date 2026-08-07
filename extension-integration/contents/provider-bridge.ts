/**
 * Isolated-world bridge: injects the page provider and forwards postMessage
 * to the background service worker (page context cannot use chrome.* APIs).
 */

import type { PlasmoCSConfig } from 'plasmo'

import inpageUrl from 'url:../scripts/inpage.ts'

export const config: PlasmoCSConfig = {
  matches: ['<all_urls>'],
  run_at: 'document_start',
}

const LATCH_PROVIDER_REQUEST = 'LATCH_PROVIDER_REQUEST'
const LATCH_PROVIDER_RESPONSE = 'LATCH_PROVIDER_RESPONSE'

type ProviderBridgeMessage = {
  source: typeof LATCH_PROVIDER_REQUEST
  messageId: number
  type: string
  payload?: unknown
}

type BgRes<T> = { ok: boolean; data?: T; error?: { message: string; code?: string } }

function injectInpageProvider(): void {
  const root = document.documentElement
  if (root.dataset.latchInpage === '1') return
  root.dataset.latchInpage = '1'

  const script = document.createElement('script')
  script.src = inpageUrl
  script.async = false
  ;(document.head || root).prepend(script)
}

injectInpageProvider()

window.addEventListener(
  'message',
  (event: MessageEvent) => {
    if (event.source !== window) return
    const data = event.data as ProviderBridgeMessage
    if (!data || data.source !== LATCH_PROVIDER_REQUEST) return
    if (typeof data.messageId !== 'number' || typeof data.type !== 'string') return

    void (async () => {
      let res: BgRes<unknown>
      try {
        res = (await chrome.runtime.sendMessage({
          type: data.type,
          payload: data.payload,
        })) as BgRes<unknown>
      } catch (e) {
        res = {
          ok: false,
          error: {
            message: e instanceof Error ? e.message : String(e),
            code: 'extension_unreachable',
          },
        }
      }

      window.postMessage(
        {
          source: LATCH_PROVIDER_RESPONSE,
          messageId: data.messageId,
          ok: res?.ok ?? false,
          data: res?.data,
          error: res?.error,
        },
        window.location.origin
      )
    })()
  },
  false
)
