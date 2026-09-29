// Real filesystem, keychain and network adapters for the interfaces the
// pure modules take. Everything a test wants to fake lives behind these.
import { execFile } from "node:child_process";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import type { AccountsIo } from "./accounts.js";
import type { CredentialIo } from "./credentials.js";

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
