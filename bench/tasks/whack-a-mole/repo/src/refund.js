import { parseAmount } from './money.js';

/** Refunds are stored as negative amounts, either "-$5.00" or accounting style "(5.00)". */
export function refundTotal(entries) {
  return entries.reduce((sum, e) => sum + parseAmount(e), 0);
}
