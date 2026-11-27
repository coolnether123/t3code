import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-dom-test-environment");
// Vitest scans this source file for environment directives before it starts the test.
const environmentPragma = "\x40vitest-environment";

describe("t3code/no-dom-test-environment", () => {
  rule.valid("allows browser tests", 'import { page } from "vite-plus/test/browser";');
  rule.valid("allows similarly named packages", 'import "jsdom-helper";');
  rule.invalid("rejects line pragmas", `// ${environmentPragma} jsdom\nexport {};`);
  rule.invalid("rejects block pragmas for any environment", `/** ${environmentPragma} node */`);
  rule.invalid("rejects jsdom imports", 'import { JSDOM } from "jsdom";');
  rule.invalid("rejects happy-dom imports", 'import "happy-dom";');
  rule.invalid("rejects emulator subpaths", 'import "jsdom/lib/api.js";');
  rule.invalid("rejects dynamic imports", 'const dom = import("happy-dom");');
  rule.invalid("rejects template imports", "const dom = import(`jsdom`);");
  rule.invalid("rejects CommonJS imports", 'const dom = require("jsdom");');
  rule.invalid("rejects TypeScript require imports", 'import dom = require("happy-dom");');
  rule.invalid("rejects re-exports", 'export { JSDOM } from "jsdom";');
});
