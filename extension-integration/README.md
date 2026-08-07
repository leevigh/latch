# Extension integration fixes (copy to `latch-web-extension`)

These files fix blockers for sign-demo E2E:

1. **Page context cannot call `chrome.runtime`** — `scripts/inpage.ts` sets `window.latch` (postMessage only). `provider-bridge.ts` (isolated content script) injects it and forwards to the background.

2. **Web pages cannot navigate to `chrome-extension://…`** — `window.latch.openSignRequest()` opens the sign tab from inside the extension.

3. **Stale MAIN-world injector** — older builds registered a Plasmo MAIN-world script that called `chrome.runtime.sendMessage` directly. `background/cleanup-main-injector.ts` unregisters it on startup.

## Rebuild extension (required)

```bash
cd /path/to/latch-web-extension
pnpm --filter extension dev
# or: pnpm --filter extension build
```

Then in Chrome: `chrome://extensions` → **Reload** the Latch extension → **hard refresh** the demo page (Cmd+Shift+R).

## Files in this folder

| File | Destination |
|------|-------------|
| `contents/provider-bridge.ts` | `apps/extension/src/contents/provider-bridge.ts` |
| `scripts/inpage.ts` | `apps/extension/src/scripts/inpage.ts` |
| `background/cleanup-main-injector.ts` | `apps/extension/src/background/cleanup-main-injector.ts` (import from `background/index.ts`) |
| `BACKGROUND_AND_TYPES_PATCH.md` | Manual merge reference |
