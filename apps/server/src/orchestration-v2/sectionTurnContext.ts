import {
  projectSectionClientsDiffer,
  renderProjectSectionRules,
  resolveProjectSectionContext,
  type OrchestrationV2Run,
  type ProjectSection,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";

export function sectionTurnContext(input: {
  readonly sections: readonly ProjectSection[];
  readonly sectionId: string | null | undefined;
  readonly previous?: OrchestrationV2Run["sectionContext"];
  readonly move?: OrchestrationV2AppThread["sectionMove"];
}): NonNullable<OrchestrationV2Run["sectionContext"]> {
  const resolved = resolveProjectSectionContext(input.sections, input.sectionId);
  const section = resolved.sections.at(-1);
  const sectionId = section?.id ?? null;
  const sectionName = resolved.sections.map((entry) => entry.name).join(" › ") || "Unsorted";
  const freshMove = input.move !== undefined && input.move.id !== input.previous?.moveId;
  const moved =
    freshMove || (input.previous !== undefined && input.previous.sectionId !== sectionId);
  const previousClientScope =
    input.previous?.taskScope?.clientName || input.previous?.taskScope?.qboRealm
      ? input.previous.taskScope
      : input.previous?.scope;
  const taskScope =
    previousClientScope?.clientName || previousClientScope?.qboRealm
      ? previousClientScope
      : input.move?.previousClientScope?.clientName || input.move?.previousClientScope?.qboRealm
        ? input.move.previousClientScope
        : resolved.scope;
  const changedClient = projectSectionClientsDiffer(taskScope, resolved.scope);
  const moveNote = moved
    ? `Moved from ${freshMove ? input.move!.fromSectionName : input.previous!.sectionName} to ${sectionName}; ${sectionName}'s rules apply now`
    : "";
  const fence = changedClient
    ? "Different client. Discard earlier approvals and pending saves. Re-read the task record now. Its company must match this section before any save. If it differs, save nothing and leave one short Talk to Otis note asking which client this work is for; reuse any existing unresolved note."
    : "";
  return {
    sectionId,
    ...(input.move === undefined ? {} : { moveId: input.move.id }),
    sectionName,
    scope: resolved.scope,
    taskScope,
    text: [moveNote, renderProjectSectionRules(input.sections, sectionId), fence]
      .filter(Boolean)
      .join("\n\n"),
  };
}
