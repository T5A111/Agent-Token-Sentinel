/**
 * Offline token estimator. No tokenizer download, no API call.
 *
 * Heuristic: ~4 characters per token for Latin text and code, ~1 token per
 * CJK character, and whitespace runs are cheap. Accurate to roughly ±15%
 * against BPE tokenizers on source code and logs, which is plenty for budgeting.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x3040 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff)) cjk++;
  }
  const collapsed = text.replace(/[ \t]+/g, ' ');
  const latinChars = Math.max(0, collapsed.length - cjk);
  return Math.ceil(latinChars / 4) + cjk;
}
