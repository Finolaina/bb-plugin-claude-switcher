import { describe, expect, it } from "vitest";
import { projectKey, shareSessions, type SessionsIo } from "./sessions.js";

/**
 * An in-memory filesystem: files, directories and symlinks by absolute
 * path, plus the resolved path of any path that is a link (or sits under
 * one). Records every link, copy and symlink made.
 */
function memoryFs() {
  const files = new Set<string>();
  const dirs = new Set<string>(["/"]);
  const symlinks = new Map<string, string>();
  /** realpath overrides: a path that resolves elsewhere (a symlinked dir). */
  const real = new Map<string, string>();
  const made: string[] = [];
  const failures = new Map<string, NodeJS.ErrnoException>();
  const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  const exists = (p: string) => files.has(p) || dirs.has(p) || symlinks.has(p);
  function addDir(p: string) {
    for (let d = p; d !== "/" && !dirs.has(d); d = parent(d)) dirs.add(d);
  }
  function addFile(p: string) {
    addDir(parent(p));
    files.add(p);
  }
  function fail(op: string, path: string, code: string) {
    failures.set(
      `${op} ${path}`,
      Object.assign(new Error(`${code}: ${op} ${path}`), { code }),
    );
  }
  function check(op: string, path: string) {
    const error = failures.get(`${op} ${path}`);
    if (error !== undefined) throw error;
  }
  const io: SessionsIo = {
    exists: async (p) => exists(p),
    async realpath(p) {
      for (const [from, to] of real)
        if (p === from || p.startsWith(`${from}/`))
          return to + p.slice(from.length);
      if (!exists(p))
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return p;
    },
    async entries(dir) {
      check("entries", dir);
      const out: { name: string; directory: boolean }[] = [];
      for (const p of [...files, ...dirs, ...symlinks.keys()]) {
        if (p !== "/" && parent(p) === dir)
          out.push({
            name: p.slice(dir.length + 1),
            directory: dirs.has(p) || dirs.has(symlinks.get(p) ?? ""),
          });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    async mkdir(dir) {
      check("mkdir", dir);
      if (!dirs.has(dir)) made.push(`mkdir ${dir}`);
      addDir(dir);
    },
    async link(existing, path) {
      check("link", path);
      if (exists(path))
        throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
      files.add(path);
      made.push(`link ${existing} -> ${path}`);
    },
    async copy(from, to) {
      check("copy", to);
      files.add(to);
      made.push(`copy ${from} -> ${to}`);
    },
    async symlink(target, path) {
      check("symlink", path);
      symlinks.set(path, target);
      made.push(`symlink ${target} -> ${path}`);
    },
  };
  return { io, files, dirs, symlinks, real, made, addDir, addFile, fail };
}

const PROJECT = "/home/aitor/Desarrollo/Maquinas";
const KEY = "-home-aitor-Desarrollo-Maquinas";
const TEAM1 = "/home/aitor/.claude-cuentas/team1";
const TEAM2 = "/home/aitor/.claude-cuentas/team2";
const DEFAULT = "/home/aitor/.claude";

describe("projectKey", () => {
  it("is the path with every character but letters and digits turned into a dash, as Claude Code names it", () => {
    expect(projectKey("/home/aitor/Desarrollo/Maquinas")).toBe(
      "-home-aitor-Desarrollo-Maquinas",
    );
    // Measured on the Mac (ls ~/.claude/projects, 2026-10-29).
    expect(
      projectKey("/Users/aitor/Desarrollo/bb-plugin-claude-accounts"),
    ).toBe("-Users-aitor-Desarrollo-bb-plugin-claude-accounts");
    expect(projectKey("/Users/aitor/.bb/plugins/x_y")).toBe(
      "-Users-aitor--bb-plugins-x-y",
    );
  });
});

describe("shareSessions", () => {
  it("links into the target every session it lacks, with its folder, and touches none it has", async () => {
    const fs = memoryFs();
    fs.addDir(PROJECT);
    fs.addFile(`${TEAM1}/projects/${KEY}/aaa.jsonl`);
    fs.addDir(`${TEAM1}/projects/${KEY}/aaa/subagents`);
    fs.addFile(`${TEAM1}/projects/${KEY}/bbb.jsonl`);
    // Already in the target: left alone, though team1 has it too.
    fs.addFile(`${TEAM2}/projects/${KEY}/bbb.jsonl`);
    // Not a session's folder (no jsonl of that name): not linked.
    fs.addDir(`${TEAM1}/projects/${KEY}/memory`);
    const result = await shareSessions({
      projectPath: PROJECT,
      target: TEAM2,
      sources: [TEAM1, DEFAULT],
      io: fs.io,
    });
    expect(result).toEqual({ linked: 1, skipped: null, errors: [] });
    expect(fs.made).toEqual([
      `link ${TEAM1}/projects/${KEY}/aaa.jsonl -> ${TEAM2}/projects/${KEY}/aaa.jsonl`,
      `symlink ${TEAM1}/projects/${KEY}/aaa -> ${TEAM2}/projects/${KEY}/aaa`,
    ]);
  });

  it("does nothing where the target's projects directory is the source's (the Mac, or Linux once linked)", async () => {
    const fs = memoryFs();
    fs.addDir(PROJECT);
    fs.addDir("/home/aitor/.claude/projects");
    fs.addFile(`${TEAM1}/projects/${KEY}/aaa.jsonl`);
    fs.addDir(`${TEAM2}/projects`);
    fs.real.set(`${TEAM1}/projects`, "/home/aitor/.claude/projects");
    fs.real.set(`${TEAM2}/projects`, "/home/aitor/.claude/projects");
    const result = await shareSessions({
      projectPath: PROJECT,
      target: TEAM2,
      sources: [TEAM1, DEFAULT],
      io: fs.io,
    });
    expect(result).toEqual({ linked: 0, skipped: "shared", errors: [] });
    expect(fs.made).toEqual([]);
  });

  it("skips a project whose path is not on this machine", async () => {
    const fs = memoryFs();
    fs.addFile(`${TEAM1}/projects/${KEY}/aaa.jsonl`);
    const result = await shareSessions({
      projectPath: PROJECT,
      target: TEAM2,
      sources: [TEAM1],
      io: fs.io,
    });
    expect(result).toEqual({ linked: 0, skipped: "no-project-dir", errors: [] });
    expect(fs.made).toEqual([]);
  });

  it("creates the target's project directory, and copies a session across filesystems", async () => {
    const fs = memoryFs();
    fs.addDir(PROJECT);
    fs.addFile(`${TEAM1}/projects/${KEY}/aaa.jsonl`);
    fs.fail("link", `${TEAM2}/projects/${KEY}/aaa.jsonl`, "EXDEV");
    const result = await shareSessions({
      projectPath: PROJECT,
      target: TEAM2,
      sources: [TEAM1],
      io: fs.io,
    });
    expect(result).toEqual({ linked: 1, skipped: null, errors: [] });
    expect(fs.made).toEqual([
      `mkdir ${TEAM2}/projects/${KEY}`,
      `copy ${TEAM1}/projects/${KEY}/aaa.jsonl -> ${TEAM2}/projects/${KEY}/aaa.jsonl`,
    ]);
  });

  it("collects what failed and goes on with the rest, never throwing", async () => {
    const fs = memoryFs();
    fs.addDir(PROJECT);
    fs.addFile(`${TEAM1}/projects/${KEY}/aaa.jsonl`);
    fs.addFile(`${TEAM1}/projects/${KEY}/bbb.jsonl`);
    fs.addFile(`${DEFAULT}/projects/${KEY}/ccc.jsonl`);
    fs.addDir(`${TEAM2}/projects/${KEY}`);
    fs.fail("link", `${TEAM2}/projects/${KEY}/aaa.jsonl`, "EACCES");
    // A source that cannot be listed does not stop the next one.
    fs.fail("entries", `${DEFAULT}/projects/${KEY}`, "EIO");
    fs.addFile(`${TEAM1}/projects/${KEY}/bbb.jsonl`);
    const result = await shareSessions({
      projectPath: PROJECT,
      target: TEAM2,
      sources: [TEAM1, DEFAULT],
      io: fs.io,
    });
    expect(result.linked).toBe(1);
    expect(result.skipped).toBeNull();
    expect(result.errors).toEqual([
      `${TEAM2}/projects/${KEY}/aaa.jsonl: EACCES: link ${TEAM2}/projects/${KEY}/aaa.jsonl`,
      `${DEFAULT}/projects/${KEY}: EIO: entries ${DEFAULT}/projects/${KEY}`,
    ]);
    // Even a filesystem that throws on its first look is an error, not a throw.
    const broken = memoryFs();
    broken.io.exists = async () => {
      throw new Error("EIO: exists");
    };
    await expect(
      shareSessions({ projectPath: PROJECT, target: TEAM2, sources: [TEAM1], io: broken.io }),
    ).resolves.toEqual({ linked: 0, skipped: null, errors: ["EIO: exists"] });
  });

  it("also shares the sessions kept under the project's resolved path", async () => {
    const fs = memoryFs();
    // On the NUC /Users/aitor is a link to /home/aitor: bb may name the
    // project by one and Claude Code by the other.
    fs.addDir(PROJECT);
    fs.real.set("/Users/aitor", "/home/aitor");
    fs.addFile(`${TEAM1}/projects/${KEY}/aaa.jsonl`);
    fs.addFile(`${TEAM1}/projects/-Users-aitor-Desarrollo-Maquinas/old.jsonl`);
    fs.addDir("/Users/aitor/Desarrollo/Maquinas");
    const result = await shareSessions({
      projectPath: "/Users/aitor/Desarrollo/Maquinas",
      target: TEAM2,
      sources: [TEAM1],
      io: fs.io,
    });
    expect(result).toEqual({ linked: 2, skipped: null, errors: [] });
    expect(fs.files.has(`${TEAM2}/projects/${KEY}/aaa.jsonl`)).toBe(true);
    expect(
      fs.files.has(`${TEAM2}/projects/-Users-aitor-Desarrollo-Maquinas/old.jsonl`),
    ).toBe(true);
  });
});
