import type { OtisFront } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { frontLink, otisContext, retryText } from "./front.logic";

it("resolves only supported Front Door link kinds", () => {
  expect(frontLink("otis://node/run:example")).toEqual({ kind: "node", id: "run:example" });
  expect(frontLink("otis://task/agenda-task:example", "https://otis.example/")).toEqual({
    kind: "external",
    href: "https://otis.example/#tracker?task=agenda-task%3Aexample",
  });
  expect(frontLink("otis://task/agenda-task:example")).toBeNull();
  expect(frontLink("https://example.com/receipt")).toEqual({
    kind: "external",
    href: "https://example.com/receipt",
  });
  expect(frontLink("otis://new/example")).toBeNull();
  expect(frontLink("javascript:alert(1)")).toBeNull();
});

it("uses the original text only for the matching turn", () => {
  const reply: OtisFront.ConversationItem = {
    id: "reply",
    turnId: "turn",
    at: "2026-11-26T09:58:04Z",
    from: "otis",
    channel: "typed",
    status: "failed",
    text: "Try again?",
    basis: null,
    cards: [],
  };
  const user = {
    ...reply,
    id: "user",
    status: "done",
    from: "jared",
    text: "What is running?",
  } as const;
  expect(retryText(reply, [reply, { ...user, turnId: "other" }])).toBeUndefined();
  expect(retryText(reply, [reply, user])).toBe(user.text);
});

it("formats only context limits reported by Front Door", () => {
  const state: OtisFront.Otis1State = {
    state: "working",
    reachVia: null,
    model: "fixture",
    effort: null,
    contextTokens: 412000,
    contextLimit: 700000,
    activeHandoffs: 0,
  };
  expect(otisContext(state)).toEqual(["412k", "700k"]);
  expect(otisContext({ ...state, contextLimit: null })).toBeNull();
});
