import { describe, expect, it } from "vite-plus/test";
import { FloorController, acceptsBargeIn, floorCue } from "./floor.ts";

describe("floor control", () => {
  it.each(["Check the build.", "I need the build.", "Open the calendar.", "Show me the results."])(
    "allows continuation when recognition punctuates a brief request: %s",
    (text) => {
      const floor = new FloorController();
      floor.update({ text, revision: 1, final: true }, 0);
      expect(floor.tick(3000)).toBe(false);
      floor.activity(3100);
      expect(floor.tick(3500)).toBe(false);
    },
  );
  it("holds a short question for continuation and does not treat negated yields as permission to answer", () => {
    const floor = new FloorController();
    floor.update({ text: "What passed?", revision: 1, final: true }, 0);
    expect(floor.tick(2400)).toBe(false);
    floor.activity(2400);
    expect(floor.tick(3000)).toBe(false);
    floor.update(
      { text: "What passed? And what still needs fixing?", revision: 2, final: true },
      4000,
    );
    expect(floor.tick(4700)).toBe(true);
    for (const text of ["Don't answer yet.", "Do not speak.", "Can you, can you?"])
      expect(floorCue(text)).toBe("hold");
    expect(floorCue("I need to think about the answer")).toBe("hold");
  });
  it.each([
    "Well, um...",
    "I want to",
    "Check this and",
    "Actually, I mean",
    "So",
    "Wait, but",
    "Give me a moment.",
  ])("holds %s through long silence", (text) => {
    const floor = new FloorController();
    floor.update({ text, revision: 1, final: true }, 0);
    expect(floor.tick(3500)).toBe(false);
    expect(floor.tick(30_000)).toBe(false);
  });
  it.each([
    "You can speak.",
    "Answer",
    "You have the floor",
    "Go ahead",
    "Over to you",
    "What do you think?",
  ])("commits explicit yield %s in 200 ms even from interim text", (text) => {
    const floor = new FloorController();
    floor.update({ text, revision: 1, final: false }, 0);
    expect(floor.tick(199)).toBe(false);
    expect(floor.tick(200)).toBe(true);
    expect(floor.tick(500)).toBe(false);
  });
  it("revisions and resumed speech invalidate provisional completion", () => {
    const floor = new FloorController();
    floor.update({ text: "Read it.", revision: 1, final: true }, 0);
    expect(floor.state).toBe("provisional-end");
    floor.activity(400);
    expect(floor.state).toBe("listening");
    expect(floor.tick(700)).toBe(false);
    floor.update({ text: "Read it, but", revision: 2, final: false }, 800);
    expect(floor.update({ text: "Read it.", revision: 1, final: true }, 900)).toBe(false);
    expect(floor.tick(4000)).toBe(false);
    floor.update({ text: "Please read it tomorrow at noon.", revision: 3, final: true }, 5000);
    expect(floor.tick(5699)).toBe(false);
    expect(floor.tick(5700)).toBe(true);
  });
  it("never commits from acoustic silence alone", () => {
    const floor = new FloorController();
    floor.activity(10);
    expect(floor.tick(100_000)).toBe(false);
    expect(floorCue("I need the")).toBe("hold");
    floor.manual();
    expect(floor.state).toBe("committed");
  });
  it("requires sustained speech and a word, ignores acknowledgments and playback echo", () => {
    expect(acceptsBargeIn("", "The task finished.", 800)).toBe(false);
    expect(acceptsBargeIn("stop", "The task finished.", 50)).toBe(false);
    for (const text of ["yeah", "mm-hmm", "right", "ok", "The task finished."]) {
      expect(acceptsBargeIn(text, "The task finished.", 800)).toBe(false);
    }
    expect(acceptsBargeIn("Wait, use tomorrow instead", "The task finished.", 250)).toBe(true);
  });
});
