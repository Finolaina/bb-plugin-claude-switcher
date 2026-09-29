// Pure helpers of the settings page (app.tsx has no DOM tests; these do).

/** The notice "No Claude Code login found" applies when no listed account has a login. */
export function noLoginFound(
  accounts: ReadonlyArray<{ problem: { kind: string } | null }>,
): boolean {
  return accounts.every((a) => a.problem?.kind === "unauthenticated");
}

/** " (Website)" for the project the last automatic switch moved, "" if it is gone. */
export function projectLabel(
  projects: ReadonlyArray<{ id: string; name: string }>,
  projectId: string,
): string {
  const project = projects.find((p) => p.id === projectId);
  return project === undefined ? "" : ` (${project.name})`;
}
