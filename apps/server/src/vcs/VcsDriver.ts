import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  VcsError,
  VcsInitInput,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  VcsRepositoryIdentity,
} from "@t3tools/contracts";
import { CheckpointRef } from "@t3tools/contracts";
import * as VcsProcess from "./VcsProcess.ts";

export interface VcsCaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** The checkpoint this one follows, so a turn that switched branches starts where it landed. */
  readonly previousCheckpointRef?: CheckpointRef;
  /** Folders below `cwd` (relative, `/`-separated) that other checkpoints own, such as nested clones. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface VcsCaptureHeadCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** A commit `resolveCleanHead` returned for this folder. */
  readonly head: string;
  /**
   * When the folder was seen clean, in epoch seconds, if that was earlier than now. Commits made
   * after a checkpoint count as the turn's own work, so a late snapshot must not postdate them.
   */
  readonly seenAt?: number;
}

export interface VcsRestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** The repository recorded for the owning project, when available. */
  readonly expectedRepository?: VcsRepositoryIdentity;
  /** The canonical project repository root, when project metadata provides it. */
  readonly expectedRepositoryRoot?: string;
  /** A recorded thread branch must still be checked out when provided. */
  readonly expectedBranch?: string | null;
  /** The latest checkpoint the current worktree must still match. */
  readonly expectedCurrentCheckpointRef?: CheckpointRef;
  readonly fallbackToHead?: boolean;
  /** Run all restore validation without changing the worktree. */
  readonly validateOnly?: boolean;
  /** Folders below `cwd` the restore leaves as they are, as in a capture. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export type VcsCheckpointRestoreFailureReason =
  | "workspace-unavailable"
  | "repository-mismatch"
  | "branch-mismatch"
  | "checkpoint-missing"
  | "checkpoint-invalid"
  | "current-checkpoint-missing"
  | "current-worktree-dirty";

export type VcsCheckpointRestoreResult =
  | { readonly restored: true; readonly commitOid: string }
  | {
      readonly restored: false;
      readonly reason: VcsCheckpointRestoreFailureReason;
      readonly detail: string;
    };
export const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

export interface VcsDiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
  /** Folders below `cwd` left out of the diff, as in a capture. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface VcsListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface VcsDeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface VcsCheckpointOps {
  readonly captureCheckpoint: (input: VcsCaptureCheckpointInput) => Effect.Effect<void, VcsError>;
  /**
   * HEAD's commit when the folder matches it exactly: nothing staged, modified or untracked.
   * Null otherwise. One status, where a capture stages the whole worktree.
   */
  readonly resolveCleanHead: (cwd: string) => Effect.Effect<string | null, VcsError>;
  /** Snapshots a folder that was clean at `head` from that commit, without reading its files. */
  readonly captureHeadCheckpoint: (
    input: VcsCaptureHeadCheckpointInput,
  ) => Effect.Effect<void, VcsError>;
  readonly hasCheckpointRef: (
    input: Pick<VcsRestoreCheckpointInput, "cwd" | "checkpointRef">,
  ) => Effect.Effect<boolean, VcsError>;
  readonly restoreCheckpoint: (
    input: VcsRestoreCheckpointInput,
  ) => Effect.Effect<VcsCheckpointRestoreResult, VcsError>;
  readonly diffCheckpoints: (input: VcsDiffCheckpointsInput) => Effect.Effect<string, VcsError>;
  readonly listAuthoredPaths: (
    input: VcsListAuthoredPathsInput,
  ) => Effect.Effect<ReadonlySet<string> | null, VcsError>;
  readonly deleteCheckpointRefs: (
    input: VcsDeleteCheckpointRefsInput,
  ) => Effect.Effect<void, VcsError>;
}

export class VcsDriver extends Context.Service<
  VcsDriver,
  {
    readonly execute: (
      input: Omit<VcsProcess.VcsProcessInput, "command">,
    ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    readonly checkpoints: VcsCheckpointOps;
    readonly detectRepository: (
      cwd: string,
    ) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
    readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
    readonly listWorkspaceFiles: (
      cwd: string,
    ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
    readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>;
    readonly filterIgnoredPaths: (
      cwd: string,
      relativePaths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
  }
>()("t3/vcs/VcsDriver") {}
