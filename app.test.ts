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

// The host hands setup() an `app` whose slots are functions; a host that
// predates (or drops) an experimental slot simply lacks that member.
async function register(slotNames: string[]) {
  const { default: definition } = await import("./app.tsx");
  const registered: string[] = [];
  const slots = Object.fromEntries(
    slotNames.map((name) => [name, (r: { id: string }) => registered.push(`${name}:${r.id}`)]),
  );
  const setup = (definition as unknown as { setup: (app: unknown) => void }).setup;
  setup({ slots });
  return registered;
}

describe("the plugin's frontend registration", () => {
  it("registers the Settings section and the thread header control", async () => {
    expect(await register(["settingsSection", "experimental_threadHeaderAction"])).toEqual([
      "settingsSection:claude-switcher",
      "experimental_threadHeaderAction:claude-account",
    ]);
  });

  it("keeps the Settings section on a host without the experimental thread header slot", async () => {
    expect(await register(["settingsSection"])).toEqual(["settingsSection:claude-switcher"]);
  });
});
