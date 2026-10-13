export function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]/g, '-');
}

export function titleCase(text) {
  return text.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export function countWords(text) {
  return text.split(/\s+/).length;
}
