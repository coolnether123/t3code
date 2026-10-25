/** Add user-level speaking guidance to this ordinary turn, preserving the saved transcript. */
export function voiceTurnInput(messageId: string, text: string) {
  return messageId.startsWith("voice:")
    ? `${text}\n\nThis turn came through a voice call. Reply conversationally. Lead with the answer in one or two short sentences, then offer details on request. Use natural language rather than tool JSON. Include further written detail if the request needs it.`
    : text;
}
