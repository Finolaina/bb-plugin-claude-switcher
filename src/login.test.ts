import { describe, expect, it } from "vitest";
import {
  LoginFlow,
  type LoginIo,
  type LoginProcess,
  type LoginStatus,
} from "./login.js";

const NOW = Date.parse("2026-09-30T10:00:00.000Z");
const URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc";
/**
 * What `claude auth login` prints, as captured from Claude Code 2.1.285 on
 * 2026-09-30 (the address replaced): two chunks, the second with an OSC 8
 * hyperlink closed by BEL. It prints both whether or not $BROWSER worked.
 */
const OPENING = "Opening browser to sign in…\n";
const BANNER = `If the browser didn't open, visit: \u001b]8;;${URL}\u0007${URL}\u001b]8;;\u0007\nPaste code here if prompted > `;
/** The same link closed by ST, as other terminals' tools write it. */
const BANNER_ST = `If the browser didn't open, visit: \u001b]8;;${URL}\u001b\\${URL}\u001b]8;;\u001b\\\nPaste code here if prompted > `;

interface Spawned {
  command: string;
  env: Record<string, string>;
  written: string[];
  killed: boolean;
  emit: (chunk: string) => void;
  exit: (code: number | null, error?: string) => void;
}

function fakeIo(existing: string[] = []): {
  io: LoginIo;
  spawned: Spawned[];
  made: string[];
  links: [string, string][];
} {
  const spawned: Spawned[] = [];
  const made: string[] = [];
  const links: [string, string][] = [];
  const paths = new Set(existing);
  const io: LoginIo = {
    spawn({ command, env }) {
      let onOutput: (chunk: string) => void = () => {};
      let resolveExit!: (result: {
        code: number | null;
        error?: string;
      }) => void;
      const exited = new Promise<{ code: number | null; error?: string }>(
        (resolve) => {
          resolveExit = resolve;
        },
      );
      const entry: Spawned = {
        command,
        env,
        written: [],
        killed: false,
        emit: (chunk) => onOutput(chunk),
        exit: (code, error) =>
          resolveExit(error === undefined ? { code } : { code, error }),
      };
      spawned.push(entry);
      const process: LoginProcess = {
        write: (text) => entry.written.push(text),
        kill: () => {
          entry.killed = true;
          resolveExit({ code: null });
        },
        onOutput: (cb) => {
          onOutput = cb;
        },
        exited,
      };
      return process;
    },
    async mkdir(dir) {
      made.push(dir);
      if (paths.has(dir)) return false;
      paths.add(dir);
      return true;
    },
    async link(target, path) {
      if (!paths.has(target) || paths.has(path)) return false;
      paths.add(path);
      links.push([target, path]);
      return true;
    },
  };
  return { io, spawned, made, links };
}

function flow(
  io: LoginIo,
  overrides: Partial<ConstructorParameters<typeof LoginFlow>[1]> = {},
) {
  const changes: LoginStatus[] = [];
  const f = new LoginFlow(io, {
    command: () => "claude",
    helper: "/plugin/bin/open-login.sh",
    timeoutMs: 10 * 60_000,
    now: () => NOW,
    onChange: (status) => changes.push(status),
    ...overrides,
  });
  return { f, changes };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("LoginFlow", () => {
  it("runs `claude auth login` for the account's directory with the browser helper, and completes on exit 0", async () => {
    const { io, spawned, made } = fakeIo();
    const { f, changes } = flow(io);
    const status = await f.start({
      name: "team",
      configDir: "/home/.claude-accounts/team",
    });
    expect(made).toEqual(["/home/.claude-accounts/team"]);
    expect(spawned[0]?.command).toBe("claude");
    expect(spawned[0]?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: "/home/.claude-accounts/team",
      BROWSER: "/plugin/bin/open-login.sh",
    });
    expect(status).toEqual({
      name: "team",
      phase: "running",
      startedAt: NOW,
      manualUrl: null,
      wantsCode: false,
      message: null,
    });
    spawned[0]!.emit(OPENING);
    expect(f.status()).toMatchObject({ manualUrl: null, wantsCode: false });
    spawned[0]!.emit(BANNER);
    expect(f.status()).toMatchObject({ manualUrl: URL, wantsCode: true });
    spawned[0]!.exit(0);
    await tick();
    expect(f.status()).toMatchObject({ phase: "done", message: null });
    // Announced on start, when the banner arrived, and at the end.
    expect(changes.map((c) => [c.phase, c.wantsCode])).toEqual([
      ["running", false],
      ["running", true],
      ["done", true],
    ]);
  });

  it("reads the fallback address from a link closed by ST too", async () => {
    const { io, spawned } = fakeIo();
    const { f } = flow(io);
    await f.start({ name: "team", configDir: "/d/team" });
    spawned[0]!.emit(BANNER_ST);
    expect(f.status()).toMatchObject({ manualUrl: URL, wantsCode: true });
  });

  it("logs the default account in without CLAUDE_CONFIG_DIR, whatever the plugin's own environment says", async () => {
    const { io, spawned, made } = fakeIo();
    const { f } = flow(io);
    await f.start(
      { name: "main", configDir: null },
      { PATH: "/bin", CLAUDE_CONFIG_DIR: "/elsewhere", GONE: undefined },
    );
    expect(made).toEqual([]);
    expect(spawned[0]?.env).toEqual({
      PATH: "/bin",
      BROWSER: "/plugin/bin/open-login.sh",
    });
  });

  it("passes a pasted code to the login and refuses one when no login is running", async () => {
    const { io, spawned } = fakeIo();
    const { f } = flow(io);
    expect(() => f.code("abc")).toThrow(/no login/i);
    await f.start({ name: "team", configDir: "/d/team" });
    f.code("  abc#123 \n");
    expect(spawned[0]?.written).toEqual(["abc#123\n"]);
  });

  it("fails with the login's last line when it exits with an error, without any URL", async () => {
    const { io, spawned } = fakeIo();
    const { f } = flow(io);
    await f.start({ name: "team", configDir: "/d/team" });
    spawned[0]!.emit(`${BANNER}\nInvalid code. See ${URL} for help\n`);
    spawned[0]!.exit(1);
    await tick();
    expect(f.status()).toMatchObject({
      phase: "failed",
      message: "Invalid code. See <url> for help (exit code 1)",
    });
  });

  it("keeps reading after the banner: the failure it reports is the last thing printed", async () => {
    const { io, spawned } = fakeIo();
    const { f } = flow(io);
    await f.start({ name: "team", configDir: "/d/team" });
    spawned[0]!.emit(OPENING);
    spawned[0]!.emit(BANNER);
    spawned[0]!.emit("\nLogin failed: Request failed with status code 400\n");
    spawned[0]!.exit(1);
    await tick();
    expect(f.status()).toMatchObject({
      phase: "failed",
      message: "Login failed: Request failed with status code 400 (exit code 1)",
    });
  });

  it("keeps the fallback address however much the login prints after it", async () => {
    const { io, spawned } = fakeIo();
    const { f } = flow(io);
    await f.start({ name: "team", configDir: "/d/team" });
    spawned[0]!.emit(BANNER);
    for (let i = 0; i < 40; i++) spawned[0]!.emit(`${"x".repeat(1023)}\n`);
    expect(f.status()).toMatchObject({ manualUrl: URL, wantsCode: true });
  });

  it("reports a login command that could not start", async () => {
    const { io, spawned } = fakeIo();
    const { f } = flow(io);
    await f.start({ name: "team", configDir: "/d/team" });
    spawned[0]!.exit(null, "spawn claude ENOENT");
    await tick();
    expect(f.status()).toMatchObject({
      phase: "failed",
      message: "could not run claude: spawn claude ENOENT",
    });
  });

  it("cancels a running login, and a cancel afterwards clears the outcome", async () => {
    const { io, spawned } = fakeIo();
    const { f } = flow(io);
    await f.start({ name: "team", configDir: "/d/team" });
    f.cancel();
    await tick();
    expect(spawned[0]?.killed).toBe(true);
    expect(f.status()).toMatchObject({ phase: "cancelled" });
    f.cancel();
    expect(f.status()).toBeNull();
  });

  it("allows one login at a time, and another once the last one ended", async () => {
    const { io, spawned } = fakeIo();
    const { f } = flow(io);
    await f.start({ name: "team", configDir: "/d/team" });
    await expect(
      f.start({ name: "side", configDir: "/d/side" }),
    ).rejects.toThrow(/login of team is still running/);
    spawned[0]!.exit(0);
    await tick();
    await f.start({ name: "side", configDir: "/d/side" });
    expect(f.status()).toMatchObject({ name: "side", phase: "running" });
  });

  it("gives up after the timeout", async () => {
    let now = NOW;
    const { io, spawned } = fakeIo();
    const { f } = flow(io, { timeoutMs: 1_000, now: () => now });
    await f.start({ name: "team", configDir: "/d/team" });
    now = NOW + 1_500;
    await new Promise((r) => setTimeout(r, 1_050));
    expect(spawned[0]?.killed).toBe(true);
    expect(f.status()).toMatchObject({
      phase: "failed",
      message: "timed out after 1 minute",
    });
  });

  it("shares the default account's settings and transcripts with a directory it creates", async () => {
    const { io, links } = fakeIo([
      "/home/.claude/projects",
      "/home/.claude/settings.json",
      "/home/.claude/skills",
      "/home/.claude/todos",
    ]);
    const shared: string[][] = [];
    const { f } = flow(io, { onShared: (_name, names) => shared.push(names) });
    await f.start({
      name: "team",
      configDir: "/accounts/team",
      shareFrom: "/home/.claude",
    });
    // What exists there among the shared names, and nothing else (no todos).
    expect(links).toEqual([
      ["/home/.claude/projects", "/accounts/team/projects"],
      ["/home/.claude/settings.json", "/accounts/team/settings.json"],
      ["/home/.claude/skills", "/accounts/team/skills"],
    ]);
    expect(shared).toEqual([["projects", "settings.json", "skills"]]);
  });

  it("leaves a directory that already existed as it is", async () => {
    const { io, links } = fakeIo(["/accounts/team", "/home/.claude/projects"]);
    const { f } = flow(io);
    await f.start({
      name: "team",
      configDir: "/accounts/team",
      shareFrom: "/home/.claude",
    });
    expect(links).toEqual([]);
  });

  it("reports a directory that could not be created", async () => {
    const { io } = fakeIo();
    io.mkdir = async () => {
      throw new Error("EACCES: permission denied");
    };
    const { f } = flow(io);
    await expect(
      f.start({ name: "team", configDir: "/d/team" }),
    ).rejects.toThrow(/EACCES/);
    expect(f.status()).toBeNull();
  });
});
