/**
 * Site parser config — stored in chrome.storage.sync so it syncs across devices.
 * Key: trarxiv:sc:{hostname}
 * Value: { hostname, titleSel, abstractSel, sectionSel, headingSel, paragraphSel,
 *           confidence, note, savedAt }
 */
const SC_PREFIX = 'trarxiv:sc:';

export async function getSiteConfig(hostname) {
  return new Promise(resolve =>
    chrome.storage.sync.get(SC_PREFIX + hostname, r =>
      resolve(r[SC_PREFIX + hostname] ?? null)
    )
  );
}

export async function saveSiteConfig(config) {
  const key = SC_PREFIX + config.hostname;
  return new Promise(resolve =>
    chrome.storage.sync.set({ [key]: { ...config, savedAt: Date.now() } }, resolve)
  );
}

export async function deleteSiteConfig(hostname) {
  return new Promise(resolve =>
    chrome.storage.sync.remove(SC_PREFIX + hostname, resolve)
  );
}

export async function getAllSiteConfigs() {
  return new Promise(resolve =>
    chrome.storage.sync.get(null, all => {
      const configs = Object.entries(all)
        .filter(([k]) => k.startsWith(SC_PREFIX))
        .map(([, v]) => v);
      resolve(configs.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)));
    })
  );
}
