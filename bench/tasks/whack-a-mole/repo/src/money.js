/** Parse a money string like "$1,234.50" into a number. */
export function parseAmount(text) {
  return Number(String(text).replace('$', ''));
}
