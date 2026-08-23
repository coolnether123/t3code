import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ChangeRequestSettleSource } from "@t3tools/client-runtime/state/thread-settled";
import { CheckIcon, ChevronDownIcon, CopyIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import GitActionsControl from "../GitActionsControl";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { useRemoteOpenState, type RemoteOpenMode } from "../../remoteOpen";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  /** Drafts have no server thread yet, so the title carries no action menu. */
  isServerThread: boolean;
  /** PR feeding the settled classification, resolved by ChatView. */
  changeRequest: ChangeRequestSettleSource | null;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  activeProjectFaviconPath: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  transcript: string;
  readonly onOpenPullRequest?: ((number: number) => void) | undefined;
  onNewThreadInProject: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function CompactTaskActions({
  open,
  onOpenChange,
  reservePanelControls,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reservePanelControls: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-mobile-chat-header-actions
      className={cn(
        "no-drag relative flex shrink-0 @xl/header-actions:hidden",
        // PanelLayoutControls is an absolute two-button cluster at the same
        // right inset. Reserve its full compact hit area while it is shown;
        // otherwise its z-50 target sits over this button on touch screens.
        reservePanelControls ? "mr-[4.5rem]" : "mr-0",
      )}
    >
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          aria-label="Task actions"
          render={
            <Button
              size="icon-xl"
              variant="ghost"
              className="size-11"
              title="Task actions"
              data-mobile-header-overflow
            />
          }
        >
          <MoreHorizontalIcon aria-hidden className="size-5" strokeWidth={2.25} />
        </PopoverTrigger>
        <PopoverPopup
          align="end"
          className="w-[min(19rem,calc(100vw-env(safe-area-inset-left)-env(safe-area-inset-right)-1rem))]"
          viewportClassName="p-2"
        >
          {children}
        </PopoverPopup>
      </Popover>
    </div>
  );
}

/**
 * Rename commit rule shared with the sidebar's inline rename: trim, reject
 * empty (the caller toasts), and skip the mutation when nothing changed.
 */
export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// How long a click on the thread title waits before opening the action menu,
// so a double-click-to-rename can cancel it first. Only the native desktop
// menu needs this: it swallows input while open, so the wait must cover the
// OS double-click interval. The browser fallback menu keeps seeing DOM
// events (the second click dismisses it and dblclick still fires), so it
// opens immediately.
const TITLE_MENU_OPEN_DELAY_MS = 500;

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly remoteOpenMode: RemoteOpenMode;
}): boolean {
  if (!input.activeProjectName) return false;
  if (
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  ) {
    return true;
  }
  // Remote environments get the picker in deep-link mode (or its explicit
  // "no SSH route" state). Non-primary local backends (e.g. WSL) keep it
  // hidden, matching pre-remote behavior.
  return input.remoteOpenMode !== "local-exec";
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  isServerThread,
  changeRequest,
  activeProjectName,
  activeProjectCwd,
  activeProjectFaviconPath,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  transcript,
  onOpenPullRequest,
  onNewThreadInProject,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "task transcript",
    onCopy: () => toastManager.add({ type: "success", title: "Chat copied" }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy chat", description: error.message }),
  });
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const remoteOpenState = useRemoteOpenState(activeThreadEnvironmentId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    remoteOpenMode: remoteOpenState.mode,
  });
  const activeThreadRef = useMemo(
    () => scopeThreadRef(activeThreadEnvironmentId, activeThreadId),
    [activeThreadEnvironmentId, activeThreadId],
  );
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  // Inline rename, keyed by thread: navigating away drops an in-progress
  // rename instead of committing stale text. Cleared on thread change (not
  // just hidden) so returning to the thread doesn't revive the old draft.
  const [renaming, setRenaming] = useState<{ threadId: ThreadId; title: string } | null>(null);
  if (renaming !== null && renaming.threadId !== activeThreadId) {
    setRenaming(null);
  }
  const renamingTitle = renaming?.threadId === activeThreadId ? renaming.title : null;
  const renameCommittedRef = useRef(false);
  const startRename = useCallback(() => {
    renameCommittedRef.current = false;
    setRenaming({ threadId: activeThreadId, title: activeThreadTitle });
  }, [activeThreadId, activeThreadTitle]);
  const commitRename = useCallback(
    (title: string) => {
      setRenaming(null);
      const resolution = resolveRenameCommit({ title, originalTitle: activeThreadTitle });
      if (resolution.action === "reject-empty") {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (resolution.action === "noop") return;
      void updateThreadMetadata({
        environmentId: activeThreadEnvironmentId,
        input: { threadId: activeThreadId, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [activeThreadEnvironmentId, activeThreadId, activeThreadTitle, updateThreadMetadata],
  );
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    changeRequest,
    onStartRename: startRename,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = useCallback(() => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  }, []);
  // Drop a pending menu-open when the thread changes or the header unmounts,
  // so it can never fire for a thread the user already left.
  useEffect(
    () => () => {
      cancelPendingTitleMenu();
    },
    [activeThreadId, cancelPendingTitleMenu],
  );
  const openTitleMenuNow = useCallback(() => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  }, [cancelPendingTitleMenu, openMenu]);
  const openMenuFromTitle = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      // The trailing click of a double-click belongs to rename, not the menu.
      if (isTrailingDoubleClick(event.detail)) return;
      // Keyboard activation and the explicit chevron affordance can never be
      // the first half of a double-click, so they open without waiting.
      const clickedChevron =
        (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
      if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
        openTitleMenuNow();
        return;
      }
      // Stay pending long enough for dblclick to cancel the open before the
      // native menu appears and swallows the second click.
      cancelPendingTitleMenu();
      titleMenuTimerRef.current = window.setTimeout(() => {
        titleMenuTimerRef.current = null;
        openTitleMenuNow();
      }, TITLE_MENU_OPEN_DELAY_MS);
    },
    [cancelPendingTitleMenu, openTitleMenuNow],
  );
  const handleTitleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // The chevron is the explicit menu affordance; only the title text renames.
      if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
      cancelPendingTitleMenu();
      closeMenu();
      startRename();
    },
    [cancelPendingTitleMenu, closeMenu, startRename],
  );
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const handleHeaderContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (!isServerThread || renamingTitle !== null) return;
      // The right-side controls (git, scripts, open-in) keep their own
      // behavior; only the breadcrumb area opens the thread menu.
      if ((event.target as HTMLElement).closest("[data-chat-header-actions]")) return;
      cancelPendingTitleMenu();
      event.preventDefault();
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [cancelPendingTitleMenu, isServerThread, openMenu, renamingTitle],
  );
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        renameCommittedRef.current = true;
        commitRename(event.currentTarget.value);
      } else if (event.key === "Escape") {
        renameCommittedRef.current = true;
        setRenaming(null);
      }
    },
    [commitRename],
  );
  return (
    <div
      className="@container/header-actions flex min-w-0 flex-1 items-center gap-1 @xl/header-actions:gap-3"
      onContextMenu={handleHeaderContextMenu}
    >
      <div
        data-mobile-chat-header-context
        className="flex min-w-0 flex-1 items-center @xl/header-actions:hidden"
      >
        {isServerThread ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Thread actions for ${activeThreadTitle}`}
                  aria-haspopup="menu"
                  onClick={openMenuFromTitle}
                  className="no-drag flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              {activeProjectName ? (
                <ProjectFavicon
                  environmentId={activeThreadEnvironmentId}
                  cwd={activeProjectCwd ?? ""}
                  faviconPath={activeProjectFaviconPath}
                  className="size-4 shrink-0"
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {activeProjectName ? `${activeProjectName} / ` : ""}
                {activeThreadTitle}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {activeProjectName ? `${activeProjectName} / ` : ""}
              {activeThreadTitle}
            </TooltipPopup>
          </Tooltip>
        ) : (
          <div
            aria-label={activeThreadTitle}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1"
          >
            {activeProjectName ? (
              <ProjectFavicon
                environmentId={activeThreadEnvironmentId}
                cwd={activeProjectCwd ?? ""}
                faviconPath={activeProjectFaviconPath}
                className="size-4 shrink-0"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {activeProjectName ? `${activeProjectName} / ` : ""}
              {activeThreadTitle}
            </span>
          </div>
        )}
      </div>
      <WorkspaceBreadcrumb
        ariaLabel="Thread breadcrumb"
        className="hidden flex-1 @xl/header-actions:block"
      >
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <>
            <WorkspaceBreadcrumbItem>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`New thread in ${activeProjectName}`}
                      onClick={onNewThreadInProject}
                      className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  <ProjectFavicon
                    environmentId={activeThreadEnvironmentId}
                    cwd={activeProjectCwd ?? ""}
                    faviconPath={activeProjectFaviconPath}
                    className="size-3.5"
                  />
                  <span className="max-w-40 truncate">{activeProjectName}</span>
                </TooltipTrigger>
                <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
          </>
        ) : null}
        <WorkspaceBreadcrumbItem current className="flex-1">
          {renamingTitle !== null ? (
            <input
              autoFocus
              aria-label="Thread title"
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ) : isServerThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Thread actions for ${activeThreadTitle}`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    onDoubleClick={handleTitleDoubleClick}
                    onBlur={cancelPendingTitleMenu}
                    className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <h2 className="min-w-0 truncate">{activeThreadTitle}</h2>
                <ChevronDownIcon
                  aria-hidden
                  data-thread-title-chevron
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <h2 aria-label={activeThreadTitle} className="min-w-0 flex-1 truncate">
                    {activeThreadTitle}
                  </h2>
                }
              />
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          )}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <CompactTaskActions
        open={mobileActionsOpen}
        onOpenChange={setMobileActionsOpen}
        reservePanelControls={!rightPanelOpen}
      >
        <div aria-label="Task actions" className="flex min-w-0 flex-col gap-1" role="group">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 w-full justify-start border-0 px-3"
            aria-label={isCopied ? "Chat copied" : "Copy chat"}
            onClick={() => {
              copyToClipboard(transcript, undefined);
              setMobileActionsOpen(false);
            }}
          >
            {isCopied ? (
              <CheckIcon aria-hidden className="size-4" />
            ) : (
              <CopyIcon aria-hidden className="size-4" />
            )}
            {isCopied ? "Chat copied" : "Copy chat"}
          </Button>
          {activeProjectName ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 w-full justify-start border-0 px-3"
              onClick={() => {
                setMobileActionsOpen(false);
                onNewThreadInProject();
              }}
            >
              <PlusIcon aria-hidden className="size-4" />
              New task in {activeProjectName}
            </Button>
          ) : null}
          {(activeProjectScripts || showOpenInPicker || activeProjectName) && (
            <div className="my-1 h-px bg-border" aria-hidden />
          )}
          <div className="grid min-w-0 gap-2 px-1 pb-1 [&_[data-slot=button]]:min-h-11 [&_[data-slot=button]]:min-w-11">
            {activeProjectScripts ? (
              <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 px-2">
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  Project actions
                </span>
                <ProjectScriptsControl
                  scripts={activeProjectScripts}
                  fileScripts={fileScripts}
                  keybindings={keybindings}
                  preferredScriptId={preferredScriptId}
                  onRunScript={onRunProjectScript}
                  onAddScript={onAddProjectScript}
                  onUpdateScript={onUpdateProjectScript}
                  onDeleteScript={onDeleteProjectScript}
                />
              </div>
            ) : null}
            {showOpenInPicker ? (
              <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 px-2">
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  Open in editor
                </span>
                <OpenInPicker
                  environmentId={activeThreadEnvironmentId}
                  keybindings={keybindings}
                  availableEditors={availableEditors}
                  openInCwd={openInCwd}
                  compact
                  enableShortcut={false}
                />
              </div>
            ) : null}
            {activeProjectName ? (
              <div className="flex min-h-11 min-w-0 items-center justify-between gap-3 px-2">
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  Git actions
                </span>
                <GitActionsControl
                  gitCwd={gitCwd}
                  activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
                  onOpenPullRequest={onOpenPullRequest}
                  {...(draftId ? { draftId } : {})}
                />
              </div>
            ) : null}
          </div>
        </div>
      </CompactTaskActions>
      <div
        data-chat-header-actions
        className={cn(
          "hidden shrink-0 items-center justify-end gap-2 @xl/header-actions:flex @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "@xl/header-actions:pr-16",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="no-drag min-h-9 shrink-0 gap-1.5 px-2.5"
                aria-label={isCopied ? "Chat copied" : "Copy chat"}
                onClick={() => copyToClipboard(transcript, undefined)}
              />
            }
          >
            {isCopied ? (
              <CheckIcon aria-hidden className="size-3.5" />
            ) : (
              <CopyIcon aria-hidden className="size-3.5" />
            )}
            <span>Copy chat</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {isCopied ? "Copied full chat" : "Copy full chat"}
          </TooltipPopup>
        </Tooltip>
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            fileScripts={fileScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            onOpenPullRequest={onOpenPullRequest}
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
