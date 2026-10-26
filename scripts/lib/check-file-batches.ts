export function checkFileBatches(
  files: readonly string[],
  maxCharacters = 16_000,
  maxFiles = Number.POSITIVE_INFINITY,
): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let characters = 0;
  for (const file of files) {
    // JSON quoting overestimates Windows argv escaping, leaving space for the CLI prefix.
    const length = JSON.stringify(file).length + 1;
    if (length > maxCharacters)
      throw new Error(`Check argument exceeds the command limit: ${file}`);
    if (batch.length > 0 && (characters + length > maxCharacters || batch.length >= maxFiles)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(file);
    characters += length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
