import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeAccountsIo } from "./node-io.js";

let base = "";
afterEach(async () => {
  if (base !== "") await rm(base, { recursive: true, force: true });
  base = "";
});

describe("nodeAccountsIo.listDirs", () => {
  it("treats a missing accounts dir as empty, and reports any other failure", async () => {
    const io = nodeAccountsIo();
    base = await mkdtemp(join(tmpdir(), "claude-accounts-"));
    expect(await io.listDirs(join(base, "missing"))).toEqual([]);
    // A file where the dir should be (ENOTDIR): not "no accounts", a failure
    // the caller must see, or a transient error would forget every account.
    const file = join(base, "not-a-dir");
    await writeFile(file, "");
    await expect(io.listDirs(file)).rejects.toThrow(/ENOTDIR/);
  });
});
