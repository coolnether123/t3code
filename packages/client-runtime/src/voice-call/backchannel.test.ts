import { expect, it } from "vite-plus/test";
import { BackchannelPolicy } from "./backchannel.ts";

const clause =
  "I have been looking through the latest results and the first part seems reasonable,";
it("offers sparse alternating clips and invalidates them on resumed speech or revision", () => {
  const policy = new BackchannelPolicy();
  policy.reset(0);
  policy.update({ text: clause, revision: 1, final: true }, 8000);
  const first = policy.cue(8400)!;
  expect(first.token).toBe("mm-hmm");
  policy.activity(8450);
  expect(policy.valid(first, 8500)).toBe(false);
  policy.update({ text: clause, revision: 2, final: true }, 9000);
  const next = policy.cue(9400)!;
  policy.played(next, 9400);
  policy.update({ text: clause, revision: 3, final: true }, 10_000);
  expect(policy.cue(10_400)).toBeUndefined();
  policy.update({ text: clause, revision: 4, final: true }, 19_000);
  expect(policy.cue(19_400)?.token).toBe("mm");
});
it.each([
  "What should I do with all these results and what is the next step?",
  "I have finished explaining the entire situation and you can speak.",
  "um",
  "The results look fine.",
])("does not take a question, yield or short turn: %s", (text) => {
  const policy = new BackchannelPolicy();
  policy.reset(0);
  policy.update({ text, revision: 1, final: true }, 10_000);
  expect(policy.cue(10_400)).toBeUndefined();
});
