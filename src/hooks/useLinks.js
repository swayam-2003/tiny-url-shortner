const STORAGE_KEY = 'tinyurl_links';

export function getLinks() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function saveLink(link) {
  const links = getLinks().filter((l) => l.shortCode !== link.shortCode);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([link, ...links]));
}

export function removeLink(shortCode) {
  const links = getLinks().filter((l) => l.shortCode !== shortCode);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
}
