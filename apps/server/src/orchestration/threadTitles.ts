import * as DateTime from "effect/DateTime";

export const DEFAULT_THREAD_TITLE = "New thread";

const DATE_PREFIX = /^(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\s+/;
const creationTimeZone = DateTime.zoneMakeNamedUnsafe("America/New_York");

export function withCreationDate(title: string, createdAt: string): string {
  const date = DateTime.toParts(DateTime.setZone(DateTime.makeUnsafe(createdAt), creationTimeZone));
  let text = title.trim();
  while (DATE_PREFIX.test(text)) text = text.replace(DATE_PREFIX, "");
  return `${date.month}/${date.day} ${text}`;
}

export function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}
