/**
 * Remove stale Plasmo MAIN-world injector registrations from older builds.
 * registerContentScripts silently no-ops when the id already exists, which can
 * leave an outdated script that calls chrome.runtime from the page context.
 */
const LEGACY_MAIN_INJECTOR_ID = 'srcContentsInjector'

async function unregisterLegacyMainInjector(): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [LEGACY_MAIN_INJECTOR_ID] })
  } catch {
    // not registered — fine
  }
}

void unregisterLegacyMainInjector()
chrome.runtime.onInstalled.addListener(() => {
  void unregisterLegacyMainInjector()
})
