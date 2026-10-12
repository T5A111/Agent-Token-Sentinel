import { parseAmount } from './money.js';

export function invoiceTotal(lines) {
  return lines.reduce((sum, line) => sum + parseAmount(line.amount) * line.qty, 0);
}
