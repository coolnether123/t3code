# Work-browser run ownership candidate

The optional `T3_WORK_BROWSER_BINDING` provider environment entry names an
absolute external module exporting `createT3RunBinding`. Christine's source
owner is `Automation_Harnesses/playwright_browser/t3_binding.mjs` in the shared
workroom repository. The runtime supplies its own T3 thread ID to the factory. Returning undefined
leaves an unadmitted thread on its current route, allowing a scoped pilot.
The runtime loads it before app-server launch and appends
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

This integration branch starts from the observed running Millie backend
revision `33dd9c74e454766a4b7a49fbff59370403ad5dbd`. Only the browser lifecycle
change was applied; the installed desktop app is a separate artifact. This
worktree is isolated from both release checkouts. Real sign-in, visible handoff and all device acceptance stay
with the parent; synthetic checks are not profile acceptance.

The single production caller of loadWorkBrowserRunBinding is intentional. It
keeps the external module contract separate from Effect provider orchestration.

The integration candidate passed build job
`803dba14-90b0-4ae1-88b9-6b5671ac2262`: 75 affected tests, no failures or
skips, targeted lint with zero warnings/errors, and server typecheck exit zero.
Typecheck emitted existing advisory suggestions. The server bundle also built successfully. Guarded live
activation and real T3 profile acceptance remain separate gates.

The guarded backend deployer preserves only T3_WORK_BROWSER_BINDING and
T3_WORK_BROWSER_MACHINE for this optional route. It excludes a global Deck task;
the external owner must obtain that from the current thread admission. Existing
secret-environment exclusions remain in place. No live setting changed here.

The deployment-helper change passed job2265: 17 targeted tests, zero failures
or skips, targeted lint zero warnings/errors. The candidate remains undeployed.
Millie's observed18.7GiB free was below the guarded20GiB reserve; no guard
was bypassed and no user data was removed to activate it.

An external binding may implement optional providerSpawned(pid). The runtime
calls it immediately after its own provider/desktop-relay spawn, before protocol
initialization or turn start. This is the captured child PID, not a process-name
search. A private operator receipt can pin that child's start time and command
hash for an authorized killed-run proof. The callback grants no stop authority,
exports no command arguments or credentials, and does not alter unbound threads.
Receipt callback failures use the existing binding-error log path. Operators
must refuse destructive proof actions when the spawn receipt is unavailable.
