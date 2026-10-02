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

// The host hands setup() an `app` whose slots are functions; a host that
// predates (or drops) an experimental slot simply lacks that member.
async function register(slotNames: string[]) {
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
  setup({ slots });
  return { registered };
}

describe("the plugin's frontend registration", () => {
  it("registers the Settings section and the thread header control", async () => {
    const { registered } = await register(["settingsSection", "experimental_threadHeaderAction"]);
    expect(registered).toEqual([
      { slot: "settingsSection", id: "claude-switcher", title: "Claude Switcher", component: "AccountsSection" },
      { slot: "experimental_threadHeaderAction", id: "claude-account", title: "Claude account", component: "ThreadAccount" },
    ]);
  });

  it("keeps the Settings section on a host without the experimental thread header slot", async () => {
    const { registered } = await register(["settingsSection"]);
    expect(registered.map((r) => `${r.slot}:${r.id}`)).toEqual(["settingsSection:claude-switcher"]);
  });
});
