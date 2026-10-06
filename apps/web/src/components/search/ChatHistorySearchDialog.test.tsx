import { act, createElement, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ChatHistoryMatch } from "@t3tools/contracts";
import { ChatHistorySearchDialog, CHAT_HISTORY_SEARCH_EVENT } from "./ChatHistorySearchDialog";

type Request = { kind: "search" | "read"; environmentId: string; input: Record<string, unknown> };
const state = vi.hoisted(() => ({ requests: [] as Request[], pendingNext: false }));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    chatHistorySearch: (request: Omit<Request, "kind">) => ({ ...request, kind: "search" }),
    chatHistoryRead: (request: Omit<Request, "kind">) => ({ ...request, kind: "read" }),
  },
}));
const match = (source: "t3" | "codex-app"): ChatHistoryMatch => ({
  source,
  threadId: source === "t3" ? "synthetic-t3" : "synthetic-codex",
  codexThreadId: "synthetic-codex",
  title: source === "t3" ? "Synthetic T3" : "Synthetic Codex",
  updatedAt: "2026-10-06T12:00:00.000Z",
  archived: true,
  snippet: "Synthetic needle",
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (request: Request) => {
    state.requests.push(request);
    if (request.kind === "read")
      return {
        data: {
          title: "Synthetic reader",
          messages: [
            {
              id: "synthetic-message",
              role: "user",
              text: "Synthetic transcript",
              createdAt: null,
            },
          ],
          truncated: false,
          nextOffset: request.input.offset === 0 ? 50 : null,
        },
        error: null,
        isPending: false,
      };
    if (request.environmentId === "millie")
      return { data: null, error: "Synthetic disconnected computer", isPending: false };
    if (request.input.codexCursor && state.pendingNext)
      return { data: null, error: null, isPending: true };
    return {
      data: {
        matches: [match("t3"), match("codex-app")],
        coverage: [
          { source: "t3", status: "complete", detail: "Synthetic complete projection" },
          {
            source: "codex-app",
            status: request.input.codexCursor ? "complete" : "partial",
            detail: request.input.codexCursor
              ? "Synthetic final page"
              : "Synthetic unreadable history",
            readGaps: !request.input.codexCursor,
          },
        ],
        nextCodexCursor: request.input.codexCursor ? null : "synthetic-next",
        nextT3Offset: request.input.t3Offset === 0 ? 50 : null,
      },
      error: null,
      isPending: false,
    };
  },
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => createElement("button", props),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? children : null,
  DialogPopup: (props: ComponentProps<"div">) => createElement("div", props),
  DialogHeader: (props: ComponentProps<"div">) => createElement("div", props),
  DialogTitle: (props: ComponentProps<"h2">) => createElement("h2", props),
  DialogDescription: (props: ComponentProps<"p">) => createElement("p", props),
}));

let renderer: ReactTestRenderer;
const computers = [
  { environmentId: EnvironmentId.make("elora"), label: "Elora synthetic" },
  { environmentId: EnvironmentId.make("millie"), label: "Millie synthetic" },
];
const button = (label: string) =>
  renderer.root.findAllByType("button").find((node) => node.children.join("") === label)!;
const submit = () =>
  act(() => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { hash: "" } }));
  state.requests = [];
  state.pendingNext = false;
  await act(() => {
    renderer = create(<ChatHistorySearchDialog computers={computers} />);
  });
  await act(() => button("Search all chats").props.onClick());
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("searches both named computers, preserves missing coverage across pages and opens only the selected read target", async () => {
  await submit();
  expect(
    new Set(
      state.requests
        .filter((request) => request.kind === "search")
        .map((request) => request.environmentId),
    ),
  ).toEqual(new Set(["elora", "millie"]));
  expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "Millie synthetic could not be searched",
  );
  const results = renderer.root
    .findAllByType("button")
    .filter((node) =>
      node.findAllByType("span").some((child) => child.children.includes("Synthetic Codex")),
    );
  expect(results).toHaveLength(1);
  expect(state.requests.some((request) => request.kind === "read")).toBe(false);
  expect(button("Search more Codex chats")).toBeUndefined();
  expect(state.requests.some((request) => request.input.codexCursor === "synthetic-next")).toBe(
    true,
  );
  expect(JSON.stringify(renderer.toJSON())).toContain("Coverage remains incomplete");
  await act(() => results[0]!.props.onClick());
  expect(state.requests.findLast((request) => request.kind === "read")).toMatchObject({
    environmentId: "elora",
    input: { source: "codex-app", threadId: "synthetic-codex", offset: 0 },
  });
  await act(() => button("Older messages").props.onClick());
  expect(state.requests.findLast((request) => request.kind === "read")?.input.offset).toBe(50);
  await act(() => button("Back to results").props.onClick());
  expect(JSON.stringify(renderer.toJSON())).toContain("Coverage remains incomplete");
  expect(
    state.requests.findLast(
      (request) => request.kind === "search" && request.environmentId === "elora",
    )?.input.codexCursor,
  ).toBe("synthetic-next");
});

it("supports computer selection and rejects reversed dates before sending a request", async () => {
  await act(() =>
    renderer.root.findByType("select").props.onChange({ target: { value: "millie" } }),
  );
  const dates = renderer.root.findAllByType("input").filter((node) => node.props.type === "date");
  await act(() => dates[0]!.props.onChange({ target: { value: "2026-10-07" } }));
  await act(() => dates[1]!.props.onChange({ target: { value: "2026-10-06" } }));
  await submit();
  expect(state.requests).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain("end date must be on or after");
  await act(() => dates[1]!.props.onChange({ target: { value: "2026-10-07" } }));
  await submit();
  expect(state.requests.every((request) => request.environmentId === "millie")).toBe(true);
  expect(state.requests[0]?.input.from).toBeTruthy();
});

it("pages T3 matches independently and retains the page after reading a result", async () => {
  await submit();
  await act(() => button("Show more T3 matches").props.onClick());
  expect(
    state.requests.findLast(
      (request) => request.kind === "search" && request.environmentId === "elora",
    )?.input,
  ).toMatchObject({ t3Offset: 50 });
  const result = renderer.root
    .findAllByType("button")
    .find((node) =>
      node.findAllByType("span").some((child) => child.children.includes("Synthetic Codex")),
    )!;
  await act(() => result.props.onClick());
  await act(() => button("Back to results").props.onClick());
  expect(
    state.requests.findLast(
      (request) => request.kind === "search" && request.environmentId === "elora",
    )?.input.t3Offset,
  ).toBe(50);
});

it("opens from the command palette event and removes the listener when unmounted", async () => {
  const remove = vi.spyOn(window, "removeEventListener");
  await act(() => window.dispatchEvent(new Event(CHAT_HISTORY_SEARCH_EVENT)));
  expect(renderer.root.findByType("h2").children).toContain("Search chats");
  await act(() => renderer.unmount());
  expect(remove).toHaveBeenCalledWith(CHAT_HISTORY_SEARCH_EVENT, expect.any(Function));
});

it("stops additional scanning while a page is in flight and continues when requested", async () => {
  state.pendingNext = true;
  await submit();
  await act(() => button("Stop searching").props.onClick());
  expect(JSON.stringify(renderer.toJSON())).toContain("Search stopped");
  state.pendingNext = false;
  await act(() => renderer.update(<ChatHistorySearchDialog computers={computers} />));
  expect(button("Continue searching")).toBeTruthy();
  await act(() => button("Continue searching").props.onClick());
  expect(button("Continue searching")).toBeUndefined();
  expect(JSON.stringify(renderer.toJSON())).toContain("Synthetic final page");
});

it("opens directly from the search link and listens for later links", async () => {
  await act(() => renderer.unmount());
  window.location.hash = "#search-chats";
  await act(() => {
    renderer = create(<ChatHistorySearchDialog computers={computers} />);
  });
  expect(renderer.root.findByType("h2").children).toContain("Search chats");
  await act(() => window.dispatchEvent(new Event("hashchange")));
  expect(renderer.root.findByType("h2").children).toContain("Search chats");
});
