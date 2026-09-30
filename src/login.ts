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
// A directory the plugin creates for a new account gets symlinks to what a
// thread needs from the default account's directory (SHARED): without the
// shared transcripts a project moved to the new account cannot resume its
// threads. A directory that already existed is left as it is.
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
  /** Creates the directory and its parents; true when it did not exist. */
  mkdir(dir: string): Promise<boolean>;
  /**
   * Everything in `dir`, and whether each entry is a real directory (a link
   * to one is not); empty when `dir` does not exist.
   */
  entries(dir: string): Promise<{ name: string; directory: boolean }[]>;
  /** Symlinks `path` to `target` when `target` exists and `path` does not; true when it did. */
  link(target: string, path: string): Promise<boolean>;
}

/**
 * What a new account directory shares with the default one: the session
 * transcripts (a thread cannot be resumed without them) and the user's
 * configuration. The login itself (.claude.json) is never shared.
 */
export const SHARED = [
  "projects",
  "settings.json",
  "hooks",
  "CLAUDE.md",
  "plugins",
  "skills",
  "agents",
  "commands",
  "rules",
] as const;

export interface LoginOptions {
  /** The Claude Code executable: a name looked up in PATH, or a path (read at each start). */
  command: () => string;
  /** Path of the BROWSER helper. */
  helper: string;
  timeoutMs: number;
  now: () => number;
  onChange?: (status: LoginStatus) => void;
  /**
   * A new directory was created for `name`: the entries linked into it, and
   * the ones that could not be ("entry: why").
   */
  onShared?: (name: string, linked: string[], failed: string[]) => void;
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
/**
 * Terminal escapes the login prints: the OSC 8 around its link, closed by
 * BEL (what Claude Code writes) or by ST, and colours.
 */
const ESCAPES =
  // oxlint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Credentials of the plugin's own environment: a login is for another
 * account, and must not be answered, or skipped, with these.
 */
const CREDENTIALS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
]);

/** How much of the login's output is kept (it prints a few lines). */
const OUTPUT_KEPT = 8_192;
/** How much of its last line is reported: it goes to the page and the log. */
const MESSAGE_KEPT = 200;
/** The prompt for a code, printed without a line break after it. */
const PROMPT = /^Paste code here[^>]*(?:>\s*|$)/;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export class LoginFlow {
  private current: LoginStatus | null = null;
  private process: LoginProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private output = "";
  /** The codes handed to the running login, kept out of what it reports. */
  private codes: string[] = [];
  /** The account whose directory is being prepared, before its login runs. */
  private starting: string | null = null;
  private startCancelled = false;

  constructor(
    private readonly io: LoginIo,
    private readonly options: LoginOptions,
  ) {}

  status(): LoginStatus | null {
    return this.current;
  }

  /**
   * Starts the login for an account (configDir null = the default account).
   * `shareFrom` is the default account's directory: a directory created here
   * links SHARED from it. `baseEnv` is what the login inherits;
   * CLAUDE_CONFIG_DIR and BROWSER are always replaced.
   */
  async start(
    account: {
      name: string;
      configDir: string | null;
      shareFrom?: string | null;
    },
    baseEnv: Record<string, string | undefined> = {},
  ): Promise<LoginStatus> {
    if (this.current?.phase === "running")
      throw new Error(`the login of ${this.current.name} is still running`);
    if (this.starting !== null)
      throw new Error(`the login of ${this.starting} is still starting`);
    // Reserved before the first await: a second start must not pass it.
    this.starting = account.name;
    this.startCancelled = false;
    try {
      if (account.configDir !== null)
        await this.prepare(
          account.name,
          account.configDir,
          account.shareFrom ?? null,
        );
    } finally {
      this.starting = null;
    }
    if (this.startCancelled) throw new Error("the login was cancelled");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv))
      if (
        value !== undefined &&
        key !== "CLAUDE_CONFIG_DIR" &&
        !CREDENTIALS.has(key)
      )
        env[key] = value;
    if (account.configDir !== null) env.CLAUDE_CONFIG_DIR = account.configDir;
    env.BROWSER = this.options.helper;
    this.output = "";
    this.codes = [];
    const status: LoginStatus = {
      name: account.name,
      phase: "running",
      startedAt: this.options.now(),
      manualUrl: null,
      wantsCode: false,
      message: null,
    };
    const command = this.options.command();
    let process: LoginProcess;
    try {
      process = this.io.spawn({ command, env });
    } catch (error) {
      // Refused before it ran (a command that is not a valid path).
      const failed: LoginStatus = {
        ...status,
        phase: "failed",
        message: `could not run ${command}: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.update(failed);
      return failed;
    }
    this.current = status;
    this.process = process;
    process.onOutput((chunk) => {
      const now = this.current;
      if (this.process !== process || now?.phase !== "running") return;
      // The tail is enough for the last line; what was found stays found.
      this.output = (this.output + chunk).slice(-OUTPUT_KEPT);
      const plain = this.output.replace(ESCAPES, "");
      const url = plain.match(/visit:\s*(https:\/\/\S+)/)?.[1] ?? now.manualUrl;
      const wantsCode = now.wantsCode || /Paste code here/.test(plain);
      if (url !== now.manualUrl || wantsCode !== now.wantsCode) {
        this.update({ ...now, manualUrl: url, wantsCode });
      }
    });
    this.timer = setTimeout(() => {
      if (this.current?.phase !== "running" || this.process !== process) return;
      const minutes = Math.max(1, Math.round(this.options.timeoutMs / 60_000));
      // Killed first: whatever the report does, no login is left running.
      process.kill();
      this.end(process, {
        phase: "failed",
        message: `timed out after ${minutes} minute${minutes === 1 ? "" : "s"}`,
      });
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
    const line = text.trim();
    // It is written to the login as it comes: one line, nothing to steer it.
    if (line.search(CONTROL) !== -1)
      throw new Error("a login code is one line of text");
    // A few characters are no code, and would blank half a message.
    if (line.length >= 8) this.codes = [...this.codes, line].slice(-20);
    this.process.write(`${line}\n`);
  }

  /**
   * Makes the account's directory and, when it is new, links SHARED into it.
   * One entry that cannot be linked does not stop the others or the login:
   * the directory would count as existing from then on and never be linked.
   */
  private async prepare(
    name: string,
    configDir: string,
    shareFrom: string | null,
  ): Promise<void> {
    const created = await this.io.mkdir(configDir);
    if (!created || shareFrom === null) return;
    const linked: string[] = [];
    const failed: string[] = [];
    for (const entry of SHARED) {
      try {
        if (
          await this.io.link(`${shareFrom}/${entry}`, `${configDir}/${entry}`)
        )
          linked.push(entry);
      } catch (error) {
        failed.push(
          `${entry}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.options.onShared?.(name, linked, failed);
  }

  /** Stops a running or starting login; when none runs, forgets the last outcome. */
  cancel(): void {
    if (this.starting !== null) this.startCancelled = true;
    if (this.current?.phase === "running" && this.process !== null) {
      const process = this.process;
      process.kill();
      this.end(process, { phase: "cancelled", message: null });
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
    // Its output holds the address, and was read for the message already.
    this.output = "";
    this.codes = [];
    // The address and the prompt belong to the login that just ended.
    this.update({
      ...this.current,
      ...outcome,
      manualUrl: null,
      wantsCode: false,
    });
  }

  private update(status: LoginStatus): void {
    this.current = status;
    this.options.onChange?.(status);
  }

  /**
   * The last line the login printed, for the message of a failure: URLs and
   * pasted codes blanked, the prompt and control characters out, cut short.
   */
  private lastLine(): string {
    let last = "the login ended without a message";
    let afterUrl = false;
    for (const raw of this.output.replace(ESCAPES, "").split(/\r?\n/)) {
      const blanked = raw.replace(URL_PATTERN, "<url>");
      let line = blanked.replace(CONTROL, "").trim().replace(PROMPT, "");
      for (const code of this.codes) line = line.split(code).join("<code>");
      // What is left of an address cut in two lines follows its line.
      const remnant: boolean = afterUrl && /^\S*[=&%]\S*$/.test(line);
      afterUrl = blanked !== raw || remnant;
      if (line !== "" && !remnant) last = line;
    }
    return last.length > MESSAGE_KEPT
      ? `${last.slice(0, MESSAGE_KEPT)}…`
      : last;
  }
}
