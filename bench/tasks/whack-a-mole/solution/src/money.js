/** Parse a money string like "$1,234.50", "-$5.00" or "(5.00)" into a number. */
export function parseAmount(text) {
  let t = String(text).trim();
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith('-')) {
    negative = !negative;
    t = t.slice(1);
  }
  const n = Number(t.replace(/[$,\s]/g, ''));
  if (t === '' || Number.isNaN(n)) throw new TypeError(`Invalid amount: ${text}`);
  return negative ? -n : n;
}
