import type { Root } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkCodexDirectives } from "@t3tools/client-runtime/codex-markdown-directives";
import { remarkGithubAlerts } from "./markdown-github-alerts";
import { createIncrementalMarkdownPlugin } from "./markdown-incremental";
import { remarkNormalizeListItemIndentation } from "./markdown-list-indentation";

function render(source: string, incremental?: Plugin<[], Root>, parsedSources?: string[]) {
  let tree: Root | undefined;
  const observeParsing: Plugin<[], Root> = function () {
    const original = this.parser;
    if (original) {
      this.parser = (text, file) => {
        parsedSources?.push(text);
        return original(text, file);
      };
    }
  };
  const capture: Plugin<[], Root> = () => (root) => {
    tree = structuredClone(root);
  };
  const html = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        observeParsing,
        capture,
        remarkGfm,
        remarkGithubAlerts,
        remarkNormalizeListItemIndentation,
        remarkCodexDirectives,
        ...(incremental ? [incremental] : []),
      ]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
    >
      {source}
    </ReactMarkdown>,
  );
  return { html, tree };
}

const prefix = "# Before\n\n```ts\nconst values = [1, 2];\n```\n\n";

describe("incremental Markdown parsing", () => {
  it("reuses completed fenced-code prefixes", () => {
    const incremental = createIncrementalMarkdownPlugin();
    const parsed: string[] = [];
    expect(render(prefix, incremental, parsed)).toEqual(render(prefix));
    parsed.length = 0;
    expect(render(prefix + "next", incremental, parsed)).toEqual(render(prefix + "next"));
    expect(parsed).not.toContain(prefix + "next");
  });

  it.each([
    "a\n===\n\nb\n---\n",
    "- first\n\n  continued\n\n- next\n",
    "> quoted\n>\n> ```js\n> abc\n> ```\n\nend",
    "<div>\nhello\n\n</div>\n\nend",
    "[ref]\n\n[ref]: /later",
    "a[^x]\n\n[^x]: note",
    "a | b\n--|--\na | b\n",
    "```\na\n```\n\nnext\n\n~~~\nb\n~~~\n\nmore",
    "> [!NOTE]\n> alert\n\n- [ ] task",
  ])("matches full parsing for streaming prefix %j", (tail) => {
    const source = prefix + tail;
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental), `prefix ${end}`).toEqual(render(text));
    }
  });

  it.each(["\r\n", "\r"])("matches partial %j line endings", (newline) => {
    const source = (prefix + "next\n\n```\nlast\n```\n\nend").replaceAll("\n", newline);
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 0; end <= source.length; end++) {
      const text = source.slice(0, end);
      expect(render(text, incremental)).toEqual(render(text));
    }
  });

  it("reparses when a document-wide definition arrives and invalidates edits", () => {
    const incremental = createIncrementalMarkdownPlugin();
    for (const text of [
      "[later]\n\n" + prefix + "plain",
      "[later]\n\n" + prefix + "[later]: /target",
      prefix + "plain",
      "replacement",
    ]) {
      expect(render(text, incremental)).toEqual(render(text));
    }
  });
});
