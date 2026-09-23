import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { getSharedHighlighter } from "@pierre/diffs";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it, vi } from "vite-plus/test";

import { createIncrementalHighlightedDocument } from "../../lib/incrementalHighlighting";
import { HighlightedCodeLines } from "./HighlightedCodeLines";

describe("highlighted code lines", () => {
  it("matches the highlighter HTML, including escaping and blank lines", async () => {
    const highlighter = await getSharedHighlighter({
      langs: ["typescript"],
      themes: ["pierre-dark"],
      preferredHighlighter: "shiki-wasm",
    });
    const highlight = createIncrementalHighlightedDocument(
      highlighter,
      "typescript",
      "pierre-dark",
    );
    const code = 'const html = "<img src=x onerror=alert(1)>";\n\n/* multi\nline */\n';
    for (let end = 0; end <= code.length; end++) {
      const root = highlight(code.slice(0, end));
      expect(renderToStaticMarkup(<HighlightedCodeLines root={root} />)).toBe(toHtml(root));
    }
  });

  it("retains completed line component identity as new lines arrive", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const highlighter = await getSharedHighlighter({
      langs: ["typescript"],
      themes: ["pierre-dark"],
      preferredHighlighter: "shiki-wasm",
    });
    const highlight = createIncrementalHighlightedDocument(
      highlighter,
      "typescript",
      "pierre-dark",
    );
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<HighlightedCodeLines root={highlight("const first = 1;\n")} />);
      });
      const initialLine = renderer!.root.findAll(
        (node) => typeof node.type === "string" && node.props.className === "line",
      )[0];
      expect(initialLine).toBeDefined();
      await act(async () => {
        renderer!.update(
          <HighlightedCodeLines root={highlight("const first = 1;\nconst second = 2;\n")} />,
        );
      });
      const nextLine = renderer!.root.findAll(
        (node) => typeof node.type === "string" && node.props.className === "line",
      )[0];
      expect(nextLine).toBe(initialLine);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});
