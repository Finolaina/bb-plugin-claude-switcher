import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// app.tsx has no DOM tests (see README, Development); this guards the r3
// regression where two empty-state blocks were pasted twice.
describe("app.tsx", () => {
  it("renders each empty state once, and the no-login one only when no account is logged in", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(source.split("No projects yet.")).toHaveLength(2);
    expect(source.split("No Claude Code login found")).toHaveLength(2);
    // The default account is always listed, so "no accounts" never happens:
    // the message is for "no account is logged in".
    expect(source).not.toContain("state.accounts.length === 0");
    expect(source).toContain("noLoginFound(state.accounts)");
  });
});

// The thread header vanished whenever its reads were slow or failed (bb
// busy, 2026-10-02): no DOM tests here, so these guard the two fixes.
describe("the thread header's reads", () => {
  it("starts from the last list any view saw, and retries a failed read instead of staying empty", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(source).toContain("useState<State | null>(lastSeen)");
    expect(source).toContain("lastSeen = next;");
    // accounts_list and threads.get both try again after a failure.
    expect(source.split("retryDelayMs(")).toHaveLength(3);
    // A thread keeps its provider: asked once per thread.
    expect(source).toContain("claudeThreads.set(threadId, claude)");
  });
});

// The new-thread control (0.2.9): no DOM tests here either, so these guard
// its wiring to the helpers tested in src/ui.test.ts.
describe("the new-thread account control", () => {
  it("lets a pick of the shown account keep it, follows the compact layout and asks for a missing project", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(source).toContain("picksOnSelect(account.name, status.account, newThread)");
    expect(source).toContain("isCompactViewport={compact}");
    // ...and again after a failed read (askForProject, src/ui.test.ts): the
    // whole effect, its condition and its dependencies.
    expect(source).toContain(`    if (!missing) return;
    return askForProject(
      () => readProject(projectId),
      failedReads,
      () => setFailedReads((n) => n + 1),
    );
  }, [missing, projectId, readProject, failedReads]);`);
    // bb's input lock only stops typing, not a send: not used (DESIGN).
    expect(source).not.toContain("setInputLock");
    // The composer sits in bb's <form>, and the mobile menu trigger sets no
    // type of its own: without this, opening the menu sends the draft.
    expect(source).toMatch(/<Button\s+type="button"\s+variant="ghost"\s+size="sm"\s+className="h-7 gap-1\.5 px-2 text-xs"/);
    expect(source).toContain("newThread && state.autoSwitch && !status.external");
    expect(source).toContain("key={projectId}");
    expect(source).toContain('rpc.call("accounts_list", { project })');
    expect(source).not.toContain("account.name !== status.account)");
  });
});

// The host hands setup() an `app` whose slots are functions; a host that
// predates (or drops) an experimental slot simply lacks that member.
async function register(slotNames: string[], withComposer = false) {
  const { default: definition } = await import("./app.tsx");
  const registered: { slot: string; id: string; title: string; component: unknown }[] = [];
  const slots = Object.fromEntries(
    slotNames.map((name) => [
      name,
      (r: { id: string; title: string; component: unknown }) =>
        registered.push({
          slot: name,
          id: r.id,
          title: r.title,
          // The component by name: app.tsx exports only the plugin definition.
          component: (r.component as { name?: string }).name,
        }),
    ]),
  );
  const setup = (definition as unknown as { setup: (app: unknown) => void }).setup;
  // The composer's customizations, as the host receives them.
  const customized: { id: string; scopes: unknown; actions: { id: string; component: unknown }[] }[] = [];
  const composer = withComposer
    ? {
        customize: (r: { id: string; scopes?: unknown; actions?: { id: string; component: unknown }[] }) =>
          customized.push({
            id: r.id,
            scopes: r.scopes,
            actions: (r.actions ?? []).map((a) => ({ id: a.id, component: (a.component as { name?: string }).name })),
          }),
      }
    : undefined;
  setup({ slots, composer });
  return { registered, customized };
}

describe("the plugin's frontend registration", () => {
  it("registers the Settings section and the thread header control", async () => {
    const { registered } = await register(["settingsSection", "experimental_threadHeaderAction"]);
    expect(registered).toEqual([
      { slot: "settingsSection", id: "claude-switcher", title: "Claude Switcher", component: "AccountsSection" },
      { slot: "experimental_threadHeaderAction", id: "claude-account", title: "Claude account", component: "ThreadAccount" },
    ]);
  });

  it("puts the account control in the new-thread composer, and only there", async () => {
    const { customized } = await register(["settingsSection"], true);
    expect(customized).toEqual([
      { id: "claude-account", scopes: ["new-thread"], actions: [{ id: "claude-account", component: "NewThreadAccount" }] },
    ]);
  });

  it("keeps the other controls on a host without composer customization", async () => {
    const { registered, customized } = await register(["settingsSection", "experimental_threadHeaderAction"]);
    expect(customized).toEqual([]);
    expect(registered.map((r) => r.slot)).toEqual(["settingsSection", "experimental_threadHeaderAction"]);
  });

  it("keeps the Settings section on a host without the experimental thread header slot", async () => {
    const { registered } = await register(["settingsSection"]);
    expect(registered.map((r) => `${r.slot}:${r.id}`)).toEqual(["settingsSection:claude-switcher"]);
  });
});
