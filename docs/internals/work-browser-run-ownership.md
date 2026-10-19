# Work-browser run ownership candidate

The optional `T3_WORK_BROWSER_BINDING` provider environment entry names an
absolute external module exporting `createT3RunBinding`. Christine's source
owner is `Automation_Harnesses/playwright_browser/t3_binding.mjs` in the shared
workroom repository. The runtime loads it before app-server launch and appends
only its work_browser MCP overrides to the process configuration or desktop
daemon per-thread configuration. Without this entry, existing behavior stays
unchanged. An invalid configured module fails startup.

The runtime accepts begin/end only for its primary provider thread. Normal,
failed and interrupted turn-completion notifications end the matching turn.
Fatal nonretryable errors end its active turn. Scope closure and provider
process exit close the owner pipe. An independent browser owner therefore
receives EOF if T3 is killed. The owner is lazy and owns browser contexts rather
than relying on model cleanup calls. Native browser cleanup and old Stop/sweep
rules are unchanged until all twelve profiles have accepted the new route.

Activation, exact accepted clone, Mac identity, the existing Deck task binding,
and real T3 acceptance belong to the integration parent. This commit changes
no live environment or provider configuration. The browser implementation and
its killed-child tests live with the workroom owner. Claude, Cursor, Grok and
OpenCode retain their current routes in this candidate. Native Codex subagent
browser use is outside this candidate's primary-thread binding; do not enable
it for those runs until each child has its own binding.

This source branch starts from the installed Mac application's embedded
revision `24f044c5466e46333597eb61e7f16855babb82a2`. It is isolated from the active
release checkout. Real sign-in, visible handoff and all device acceptance stay
with the parent; synthetic checks are not profile acceptance.

The single production caller of loadWorkBrowserRunBinding is intentional. It
keeps the external module contract separate from Effect provider orchestration.
