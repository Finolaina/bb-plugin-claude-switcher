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
