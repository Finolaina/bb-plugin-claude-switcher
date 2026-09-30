// Real filesystem, keychain and network adapters for the interfaces the
// pure modules take. Everything a test wants to fake lives behind these.
import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import type { AccountsIo } from "./accounts.js";
import type { CredentialIo } from "./credentials.js";
import type { LoginIo } from "./login.js";

const SECURITY = "/usr/bin/security";
/** A keychain prompt or a hung agent must not block the plugin forever. */
const SECURITY_TIMEOUT_MS = 10_000;

function runSecurity(
  args: string[],
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    // execFile with an argument array: no shell, so the keychain service name
    // and the hex payload are never interpreted.
    execFile(
      SECURITY,
      args,
      {
        maxBuffer: 1 << 20,
        timeout: SECURITY_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        // A timeout or a spawn failure has no exit code: -1 is "did not run",
        // which the caller reports as an error, never as "no login".
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : -1;
        resolve({ code, stdout: String(stdout ?? "") });
      },
    );
  });
}

export function nodeCredentialIo(): CredentialIo {
  return {
    platform: platform(),
    username: userInfo().username,
    home: homedir(),
    exec: runSecurity,
    readFile: (path) => readFile(path, "utf8"),
    // Whole file or nothing: a crash mid-write must not leave a truncated
    // login behind (the old refresh token is already consumed by then).
    writeFile: async (path, content) => {
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, content, { mode: 0o600 });
      await rename(tmp, path);
    },
    fetch: (input, init) => fetch(input, init),
  };
}

export function nodeAccountsIo(): AccountsIo {
  return {
    home: homedir(),
    readFile: (path) => readFile(path, "utf8"),
    async listDirs(path) {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (error) {
        // No accounts dir is "no extra accounts"; anything else (EPERM, EIO,
        // an unmounted volume) must fail the refresh, or the collector
        // would forget every account, pending logins included.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}

export function nodeLoginIo(): LoginIo {
  return {
    spawn({ command, env }) {
      // No shell: the command is one executable (a name PATH resolves, or a
      // path), and its arguments are fixed.
      const child = spawn(command, ["auth", "login"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      // A login that ended closes its pipe: a write after that must not
      // take the plugin down as an unhandled error.
      child.stdin.on("error", () => {});
      const listeners: ((chunk: string) => void)[] = [];
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          for (const listener of listeners) listener(chunk);
        });
      }
      const exited = new Promise<{ code: number | null; error?: string }>(
        (resolve) => {
          // `on`: a second error (a failed kill) has a listener too.
          child.on("error", (error) =>
            resolve({ code: null, error: error.message }),
          );
          child.once("exit", (code) => resolve({ code }));
        },
      );
      return {
        write: (text) => {
          if (child.stdin.writable) child.stdin.write(text);
        },
        kill: () => {
          child.kill();
        },
        onOutput: (callback) => {
          listeners.push(callback);
        },
        exited,
      };
    },
    // `mkdir` with `recursive` answers the first directory it created, or
    // undefined when all of them existed.
    mkdir: async (dir) =>
      (await mkdir(dir, { recursive: true, mode: 0o700 })) !== undefined,
    entries: async (dir) => {
      try {
        const found = await readdir(dir, { withFileTypes: true });
        return found.map((e) => ({ name: e.name, directory: e.isDirectory() }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    link: async (target, path) => {
      try {
        await lstat(target);
      } catch {
        return false;
      }
      try {
        await symlink(target, path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    },
  };
}

/**
 * bin/open-login.sh next to the plugin's files: the source tree keeps it
 * beside server.ts, the built plugin runs from dist/ one level down.
 */
export function loginHelperPath(moduleUrl: string): string {
  const dir = fileURLToPath(new URL(".", moduleUrl));
  const root = dir.endsWith("/dist/") ? dir.slice(0, -"dist/".length) : dir;
  return `${root}bin/open-login.sh`;
}
