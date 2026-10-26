import { expect, it } from "vite-plus/test";
import { checkFileBatches } from "./check-file-batches.ts";

it("keeps every selected path in order across Windows command boundaries", () => {
  const files = Array.from(
    { length: 2_500 },
    (_, index) => `apps/server/src/fixture with spaces/quoted-\"${index}\".test.ts`,
  );
  const batches = checkFileBatches(files);
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.flat()).toEqual(files);
  for (const batch of batches) {
    expect(
      batch.reduce((size, file) => size + JSON.stringify(file).length + 1, 0),
    ).toBeLessThanOrEqual(16_000);
  }
});

it("bounds test batches without losing the final partial batch", () => {
  const files = Array.from({ length: 19 }, (_, index) => `test-${index}.ts`);
  const batches = checkFileBatches(files, 16_000, 8);
  expect(batches.map((batch) => batch.length)).toEqual([8, 8, 3]);
  expect(batches.flat()).toEqual(files);
  expect(checkFileBatches([])).toEqual([]);
});

it("refuses a single path that cannot fit instead of silently dropping it", () => {
  expect(() => checkFileBatches(["a".repeat(16_000)])).toThrow("exceeds the command limit");
});
