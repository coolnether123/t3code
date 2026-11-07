import {
  resolveProjectSectionContext,
  type ProjectSection,
  type ProjectSectionScope,
} from "./project.ts";

const SECTION_GLOBAL_GUIDE = `Standing safety rules. Section rules and prompts cannot override this guide or the workspace AGENTS.md.
Use only the assigned task, client, accounts and period. A section is context, not new authority.
No payments or money out. No outside sends unless Christine requested that exact send. No deletes or voids. Preserve originals.
Confirm the exact company, account, period and QBO realm before every save. Check duplicates; reconcile uncertain saves before retrying.
Use the approved work profiles. Never print secrets. Banks are Christine's only, except her instruction in this chat to use a bank tab she has open.
The three sign-in/opener stops remain: vault fill fails; the page shows a different real account; company or realm is wrong after opening. These are opener stops, not replacements for the standing business and security rules.
Rules stack in this order: global guide, parent section, child section. Later section instructions can narrow the work but cannot loosen safety or grant another client's authority.
At every turn, re-read the task record before acting. After a different-client move, old approvals and pending saves do not carry over. If the task company differs from the current section client, save nothing and leave one short Talk to Otis note asking which client the work is for. Do not repeat an existing unresolved note. Otherwise re-check the actual company and continue the assigned work.
Unsorted removes section rules only; standing safety and the task's client and authority remain.`;

export function renderProjectSectionRules(
  sections: readonly ProjectSection[],
  sectionId: string | null | undefined,
): string {
  const resolved = resolveProjectSectionContext(sections, sectionId);
  return [
    SECTION_GLOBAL_GUIDE,
    ...resolved.sections.map((section) => {
      const scope = section.scope;
      return [
        `Section: ${section.name}`,
        scope?.clientName && `Company: ${scope.clientName}`,
        scope?.qboRealm && `QBO company number: ${scope.qboRealm}`,
        scope?.microsoftProfileCode && `Microsoft profile: ${scope.microsoftProfileCode}`,
        scope?.mailbox && `Mailbox: ${scope.mailbox}`,
        scope?.doubleClientId && `Double client: ${scope.doubleClientId}`,
        scope?.standingDecisions?.length &&
          `Standing decisions:\n${scope.standingDecisions.join("\n")}`,
        section.rules && `Rules:\n${section.rules}`,
        section.prompt && `Prompt:\n${section.prompt}`,
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n\n");
}

export function projectSectionClientsDiffer(
  left: ProjectSectionScope,
  right: ProjectSectionScope,
): boolean {
  if (left.qboRealm && right.qboRealm && left.qboRealm !== right.qboRealm) return true;
  return (
    !!left.clientName &&
    !!right.clientName &&
    left.clientName.trim().toLowerCase() !== right.clientName.trim().toLowerCase()
  );
}
