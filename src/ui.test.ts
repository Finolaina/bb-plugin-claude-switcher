import { describe, expect, it } from "vitest";
import { noLoginFound, projectLabel } from "./ui.js";

const ok = { problem: null };
const unauth = { problem: { kind: "unauthenticated" as const } };
const failed = { problem: { kind: "error" as const, message: "boom" } };

describe("noLoginFound", () => {
  it("is true only when every listed account lacks a login", () => {
    expect(noLoginFound([unauth])).toBe(true);
    expect(noLoginFound([unauth, unauth])).toBe(true);
    expect(noLoginFound([unauth, ok])).toBe(false);
    expect(noLoginFound([ok])).toBe(false);
    // A query that failed is still a login.
    expect(noLoginFound([unauth, failed])).toBe(false);
    // The default account is always listed, so this never happens; if it
    // did, there is nothing to log in to either.
    expect(noLoginFound([])).toBe(true);
  });
});

describe("projectLabel", () => {
  const projects = [{ id: "proj-1", name: "Website" }];
  it("names the project of the last switch, or says nothing when it is gone", () => {
    expect(projectLabel(projects, "proj-1")).toBe(" (Website)");
    expect(projectLabel(projects, "proj-9")).toBe("");
  });
});
