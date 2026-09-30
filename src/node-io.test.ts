import {
  chmod,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loginHelperPath, nodeAccountsIo, nodeLoginIo } from "./node-io.js";

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

describe("nodeLoginIo", () => {
  /** An executable standing in for `claude`, written to the temp dir. */
  async function command(body: string): Promise<string> {
    const path = join(base, "fake-claude");
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it("creates the directory for its owner only, and says whether it was new", async () => {
    const io = nodeLoginIo();
    base = await mkdtemp(join(tmpdir(), "claude-accounts-"));
    const dir = join(base, "accounts", "team");
    expect(await io.mkdir(dir)).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await io.mkdir(dir)).toBe(false);
  });

  it("links what exists, once", async () => {
    const io = nodeLoginIo();
    base = await mkdtemp(join(tmpdir(), "claude-accounts-"));
    const target = join(base, "projects");
    await mkdir(target);
    const path = join(base, "link");
    expect(await io.link(join(base, "missing"), join(base, "nowhere"))).toBe(false);
    expect(await io.link(target, path)).toBe(true);
    expect(await readlink(path)).toBe(target);
    // Already there: left as it is.
    expect(await io.link(target, path)).toBe(false);
  });

  it("lists the accounts directory, telling real directories from links and files", async () => {
    const io = nodeLoginIo();
    base = await mkdtemp(join(tmpdir(), "claude-accounts-"));
    expect(await io.entries(join(base, "missing"))).toEqual([]);
    await mkdir(join(base, "team"));
    await symlink(join(base, "team"), join(base, "linked"));
    await writeFile(join(base, "file"), "");
    const found = await io.entries(base);
    expect(found.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "file", directory: false },
      { name: "linked", directory: false },
      { name: "team", directory: true },
    ]);
  });

  it("runs the command with `auth login`, passes its output on and writes to it", async () => {
    const io = nodeLoginIo();
    base = await mkdtemp(join(tmpdir(), "claude-accounts-"));
    const path = await command('echo "args: $* dir: $CLAUDE_CONFIG_DIR"\nread line\necho "got $line" >&2');
    const process = io.spawn({ command: path, env: { CLAUDE_CONFIG_DIR: "/d/team", PATH: "/usr/bin:/bin" } });
    let output = "";
    process.onOutput((chunk) => {
      output += chunk;
    });
    process.write("the-code\n");
    expect(await process.exited).toEqual({ code: 0 });
    expect(output).toBe("args: auth login dir: /d/team\ngot the-code\n");
  });

  it("reports a command that cannot run, and survives writing to a login that is gone", async () => {
    const io = nodeLoginIo();
    base = await mkdtemp(join(tmpdir(), "claude-accounts-"));
    const missing = io.spawn({ command: join(base, "no-such-command"), env: {} });
    const result = await missing.exited;
    expect(result.code).toBeNull();
    expect(result.error).toMatch(/ENOENT/);
    missing.write("x\n");
    const path = await command("exit 3");
    const gone = io.spawn({ command: path, env: {} });
    expect(await gone.exited).toEqual({ code: 3 });
    gone.write("x\n");
    gone.kill();
    // Still running, but no longer reading: the write fails on the pipe
    // (EPIPE), which without a listener is an unhandled error.
    const deaf = io.spawn({ command: await command("exec 0<&-\nsleep 0.3"), env: { PATH: "/usr/bin:/bin" } });
    await new Promise((r) => setTimeout(r, 100));
    deaf.write("x\n");
    expect(await deaf.exited).toEqual({ code: 0 });
  });
});

describe("loginHelperPath", () => {
  it("finds bin/open-login.sh beside server.ts, and one level up from dist/", () => {
    expect(loginHelperPath("file:///plugins/switcher/server.ts")).toBe(
      "/plugins/switcher/bin/open-login.sh",
    );
    expect(loginHelperPath("file:///plugins/switcher/dist/server.js")).toBe(
      "/plugins/switcher/bin/open-login.sh",
    );
    expect(loginHelperPath("file:///plugins/my%20dist/dist/server.js")).toBe(
      "/plugins/my dist/bin/open-login.sh",
    );
  });
});
