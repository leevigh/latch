# Background + types patches for latch-web-extension

## 1. `packages/types/src/externalSign.ts` — add:

```ts
/** Params for window.latch.openSignRequest (Layer 2 without chrome-extension:// redirect). */
export interface OpenSignRequestParams {
  network: Network
  /** Smart account C-address */
  account: string
  callback: string
  requestId: string
  /** Standard base64 unsigned tx XDR */
  xdr?: string
  payloadRef?: string
  submit?: boolean
  origin?: string
}

export interface DappOpenSignRequestPayload {
  origin: string
  request: ExternalSignRequest
}
```

Export `OpenSignRequestParams` from `packages/types/src/index.ts`.

## 2. `packages/types/src/index.ts` — add to MessageType union:

```ts
| 'DAPP_OPEN_SIGN_REQUEST'
```

Add to `BackgroundRequestPayloadByType`:

```ts
DAPP_OPEN_SIGN_REQUEST: import('./externalSign').DappOpenSignRequestPayload
```

Add to `BackgroundResponseDataByType`:

```ts
DAPP_OPEN_SIGN_REQUEST: undefined
```

## 3. `apps/extension/src/background/externalSign/parseSignRequest.ts` — add helpers:

```ts
export function fromBase64Url(b64url: string): string {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  return b64
}

export function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function buildSignRequestSearchParams(request: ExternalSignRequest): string {
  const params = new URLSearchParams()
  params.set('network', request.network)
  params.set('account', request.smartAccountAddress)
  if (request.unsignedTxXdr) {
    params.set('xdr', toBase64Url(request.unsignedTxXdr))
  }
  if (request.payloadRef) params.set('payloadRef', request.payloadRef)
  if (request.callback) params.set('callback', request.callback)
  if (request.requestId) params.set('requestId', request.requestId)
  if (request.submit !== undefined) params.set('submit', String(request.submit))
  if (request.origin) params.set('origin', request.origin)
  return params.toString()
}
```

In `parseSignRequestFromSearchParams`, decode xdr:

```ts
const rawXdr = params.get('xdr')?.trim()
const xdr = rawXdr ? fromBase64Url(rawXdr) : undefined
// use xdr instead of params.get('xdr')
```

## 4. `apps/extension/src/background/index.ts` — add import and case:

```ts
import { buildSignRequestSearchParams } from './externalSign/parseSignRequest'
import type { DappOpenSignRequestPayload } from '@latch/types'
```

Before `DAPP_SIGN_TRANSACTION` case, add:

```ts
case 'DAPP_OPEN_SIGN_REQUEST': {
  const req = message.payload as DappOpenSignRequestPayload
  const allowed = await getDappPermissions(req.origin)
  if (!allowed.includes('getPublicKey')) {
    const approval = await requireDappApproval({ origin: req.origin, kind: 'getPublicKey' })
    if (!approval.approved)
      throw new BackendError('User rejected', { status: 403, code: 'user_rejected' })
    await setDappPermissions(req.origin, mergePermissions(allowed, 'getPublicKey'))
  }
  const query = buildSignRequestSearchParams(req.request)
  const url = chrome.runtime.getURL(`tabs/sign-request.html?${query}`)
  await chrome.tabs.create({ url })
  sendResponse(ok())
  return
}
```

## 5. `apps/extension/src/ui/LatchRoot.tsx` — listen for pending approvals:

After the mount `useEffect` that calls `loadPendingDapp()`, add:

```ts
useEffect(() => {
  function onStorage(changes: { [key: string]: chrome.storage.StorageChange }, area: string) {
    if (area !== 'local') return
    if (changes['latch.pendingDappRequests']) {
      void loadPendingDapp().catch(() => {})
    }
  }
  chrome.storage.onChanged.addListener(onStorage)
  return () => chrome.storage.onChanged.removeListener(onStorage)
}, [])
```

(Ensure `loadPendingDapp` is stable or inline the listener logic.)
