// A Claude Code login run from bb, for one account directory at a time.
//
// `claude auth login` needs no terminal: it starts a localhost callback,
// hands the consent URL to `$BROWSER` (one executable path, no arguments)
// and, as a fallback, prints a second URL whose page shows a code to paste.
// This module runs it with CLAUDE_CONFIG_DIR set to the account's directory
// and BROWSER set to the plugin's helper (bin/open-login.sh, which opens a
// private Chrome window so the login does not reuse a browser session), and
// reports how far it got. Exit 0 means Claude Code wrote the login to its
// store; the caller then measures the account.
//
// The consent URL carries a one-time PKCE challenge: it is never logged.
// The manual URL is kept for the UI (the user may need it), nothing else.

export interface LoginProcess {
  /** Writes to the login's stdin. */
  write(text: string): void;
  kill(): void;
  /** Called with every chunk of stdout and stderr. */
  onOutput(callback: (chunk: string) => void): void;
  /** Resolves when the process ended; `error` when it could not start. */
  exited: Promise<{ code: number | null; error?: string }>;
}

export interface LoginIo {
  spawn(args: { command: string; env: Record<string, string> }): LoginProcess;
  /** Creates the directory and its parents; no error when it exists. */
  mkdir(dir: string): Promise<void>;
}

export interface LoginOptions {
  /** The Claude Code executable: a name looked up in PATH, or a path (read at each start). */
  command: () => string;
  /** Path of the BROWSER helper. */
  helper: string;
  timeoutMs: number;
  now: () => number;
  onChange?: (status: LoginStatus) => void;
}

export type LoginPhase = "running" | "done" | "failed" | "cancelled";

export interface LoginStatus {
  name: string;
  phase: LoginPhase;
  startedAt: number;
  /** The fallback URL the login printed, whose page shows a code to paste. */
  manualUrl: string | null;
  /** The login is waiting for a pasted code (it also completes on its own through the browser). */
  wantsCode: boolean;
  /** Why it failed; null otherwise. */
  message: string | null;
}

/** Any URL, for the message shown to the user; the consent URL must not travel further. */
// oxlint-disable-next-line no-control-regex
const URL_PATTERN = /https?:\/\/[^\s\u001b]+/g;
/** Terminal escapes the login prints around its link (OSC 8) and colours. */
// oxlint-disable-next-line no-control-regex
const ESCAPES = /\u001b\][^\u001b]*\u001b\\|\u001b\[[0-9;]*[A-Za-z]/g;

export class LoginFlow {
  private current: LoginStatus | null = null;
  private process: LoginProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private output = "";

  constructor(
    private readonly io: LoginIo,
    private readonly options: LoginOptions,
  ) {}

  status(): LoginStatus | null {
    return this.current;
  }

  /**
   * Starts the login for an account (configDir null = the default account).
   * `baseEnv` is what the login inherits; CLAUDE_CONFIG_DIR and BROWSER are
   * always replaced.
   */
  async start(
    account: { name: string; configDir: string | null },
    baseEnv: Record<string, string | undefined> = {},
  ): Promise<LoginStatus> {
    if (this.current?.phase === "running")
      throw new Error(`the login of ${this.current.name} is still running`);
    if (account.configDir !== null) await this.io.mkdir(account.configDir);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv))
      if (value !== undefined && key !== "CLAUDE_CONFIG_DIR") env[key] = value;
    if (account.configDir !== null) env.CLAUDE_CONFIG_DIR = account.configDir;
    env.BROWSER = this.options.helper;
    this.output = "";
    const status: LoginStatus = {
      name: account.name,
      phase: "running",
      startedAt: this.options.now(),
      manualUrl: null,
      wantsCode: false,
      message: null,
    };
    this.current = status;
    const command = this.options.command();
    const process = this.io.spawn({ command, env });
    this.process = process;
    process.onOutput((chunk) => {
      if (this.current !== status) return;
      this.output += chunk;
      const plain = this.output.replace(ESCAPES, "");
      const url = plain.match(/visit:\s*(https?:\/\/\S+)/)?.[1] ?? null;
      const wantsCode = /Paste code here/.test(plain);
      if (url !== status.manualUrl || wantsCode !== status.wantsCode) {
        this.update({ ...status, manualUrl: url, wantsCode });
      }
    });
    this.timer = setTimeout(() => {
      if (this.current?.phase !== "running" || this.process !== process) return;
      const minutes = Math.max(1, Math.round(this.options.timeoutMs / 60_000));
      this.end(process, {
        phase: "failed",
        message: `timed out after ${minutes} minute${minutes === 1 ? "" : "s"}`,
      });
      process.kill();
    }, this.options.timeoutMs);
    void process.exited.then((result) => {
      if (this.process !== process) return;
      if (this.current?.phase !== "running") return;
      if (result.error !== undefined) {
        this.end(process, {
          phase: "failed",
          message: `could not run ${command}: ${result.error}`,
        });
      } else if (result.code === 0) {
        this.end(process, { phase: "done", message: null });
      } else {
        this.end(process, {
          phase: "failed",
          message: `${this.lastLine()} (exit code ${result.code ?? "none"})`,
        });
      }
    });
    this.options.onChange?.(status);
    return status;
  }

  /** Hands a pasted code to the login. */
  code(text: string): void {
    if (this.current?.phase !== "running" || this.process === null)
      throw new Error("no login is running");
    this.process.write(`${text.trim()}\n`);
  }

  /** Stops a running login; when none runs, forgets the last outcome. */
  cancel(): void {
    if (this.current?.phase === "running" && this.process !== null) {
      const process = this.process;
      this.end(process, { phase: "cancelled", message: null });
      process.kill();
      return;
    }
    this.current = null;
  }

  private end(
    process: LoginProcess,
    outcome: { phase: LoginPhase; message: string | null },
  ): void {
    if (this.process !== process || this.current === null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.process = null;
    this.update({ ...this.current, ...outcome });
  }

  private update(status: LoginStatus): void {
    this.current = status;
    this.options.onChange?.(status);
  }

  /** The last non-empty line the login printed, URLs blanked. */
  private lastLine(): string {
    const lines = this.output
      .replace(ESCAPES, "")
      .split(/\r?\n/)
      .map((l) => l.replace(URL_PATTERN, "<url>").trim())
      .filter((l) => l !== "" && !l.startsWith("Paste code here"));
    return lines[lines.length - 1] ?? "the login ended without a message";
  }
}
