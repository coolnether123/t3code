/** One word is an NFKC-normalized Unicode letter/number run, including marks. */
export function promptWords(text: string): string[] {
  return Array.from(text.normalize("NFKC").matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu), (match) =>
    match[0].toLowerCase(),
  );
}

export const PROMPT_COMMON_WORDS = new Set(
  "a an and are as at be been but by can do for from had has have i if in is it its me my not of on or our so that the their them then there these they this to us was we were what when which who will with you your".split(
    " ",
  ),
);

export function isFrequentPromptWord(word: string): boolean {
  return (
    word.length >= 2 && word.length <= 64 && !/\p{N}/u.test(word) && !PROMPT_COMMON_WORDS.has(word)
  );
}

export function normalizePromptKeyword(value: string): string {
  const keyword = value.trim().normalize("NFKC").toLowerCase();
  if (keyword.length > 64 || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*$/u.test(keyword))
    throw new Error("Enter one word of at most 64 characters. Punctuation splits words.");
  return keyword;
}
