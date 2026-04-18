/**
 * Paper library: stores visited/translated papers in chrome.storage.local.
 * Each entry: { id, title, url, addedAt, lastVisitedAt, visitCount, tags, summary }
 */
const LIBRARY_KEY = 'trarxiv:library';

async function getAll() {
  return new Promise(resolve =>
    chrome.storage.local.get(LIBRARY_KEY, r => resolve(r[LIBRARY_KEY] ?? []))
  );
}

async function saveAll(library) {
  return new Promise(resolve =>
    chrome.storage.local.set({ [LIBRARY_KEY]: library }, resolve)
  );
}

export async function getLibrary() {
  const lib = await getAll();
  return lib.sort((a, b) => (b.lastVisitedAt ?? 0) - (a.lastVisitedAt ?? 0));
}

export async function registerPaper({ id, title, url }) {
  const library = await getAll();
  const now     = Date.now();
  const idx     = library.findIndex(p => p.id === id);
  if (idx >= 0) {
    library[idx].lastVisitedAt = now;
    library[idx].visitCount    = (library[idx].visitCount ?? 0) + 1;
    if (title && title !== library[idx].title) library[idx].title = title;
  } else {
    library.push({ id, title, url, addedAt: now, lastVisitedAt: now, visitCount: 1, tags: [], summary: '' });
  }
  return saveAll(library);
}

export async function setPaperSummary(id, summary) {
  const library = await getAll();
  const paper   = library.find(p => p.id === id);
  if (paper) { paper.summary = summary; await saveAll(library); }
}

export async function setPaperTags(id, tags) {
  const library = await getAll();
  const paper   = library.find(p => p.id === id);
  if (paper) { paper.tags = tags; await saveAll(library); }
}

export async function deletePaper(id) {
  const library = await getAll();
  return saveAll(library.filter(p => p.id !== id));
}
