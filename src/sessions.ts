// A project's Claude Code sessions, kept reachable across accounts.
//
// Claude Code keeps each session at <configDir>/projects/<key>/<sid>.jsonl
// (and its subagents and tool results in <sid>/). bb resumes a thread with
// `claude --resume <sid>` under the project's CLAUDE_CONFIG_DIR, so a thread
// whose project moved to an account whose `projects/` is another directory
// dies with "No conversation found with session ID" (twice in the NUC's
// Infra thread, 2026-10-29). On the Mac every account's `projects/` is a link
// to one directory; where it is not, the sessions the target account lacks
// are linked into it before the next turn. Nothing is ever removed or
// overwritten.

export interface SessionsIo {
  exists(path: string): Promise<boolean>;
  /** The path with every symlink resolved; throws when it does not exist. */
  realpath(path: string): Promise<string>;
  /** A directory's entries (a link to a directory counts as one); [] when it does not exist. */
  entries(dir: string): Promise<{ name: string; directory: boolean }[]>;
  /** Creates the directory and its parents; nothing when it exists. */
  mkdir(dir: string): Promise<void>;
  /** A hard link at `path` to `existing`; throws EXDEV across filesystems. */
  link(existing: string, path: string): Promise<void>;
  /** Copies `from` to `to`, failing when `to` exists. */
  copy(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}

export interface ShareResult {
  /** Sessions (jsonl) linked or copied into the target. */
  linked: number;
  /**
   * "no-project-dir": the project's path is not on this machine (a project
   * of another host); "shared": every source's `projects/` already is the
   * target's; null: looked at.
   */
  skipped: "shared" | "no-project-dir" | null;
  errors: string[];
}

/**
 * The directory name Claude Code gives a project under `projects/`: its
 * path with every character but ASCII letters and digits turned into "-".
 * ponytail: Claude Code shortens a key past 200 characters with a hash;
 * such paths are not shared (none here comes close; add the rule if one does).
 */
export function projectKey(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, "-");
}

const SESSION = /^(.+)\.jsonl$/;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolved(io: SessionsIo, path: string): Promise<string | null> {
  try {
    return await io.realpath(path);
  } catch {
    return null;
  }
}

/**
 * Links into `target`'s sessions of the project every session (and its
 * folder) one of `sources` has and the target lacks. `sources` are config
 * dirs, in order of preference: the first that has a session gives it. A
 * failure is collected in `errors`, never thrown.
 */
export async function shareSessions({
  projectPath,
  target,
  sources,
  io,
}: {
  projectPath: string;
  target: string;
  sources: readonly string[];
  io: SessionsIo;
}): Promise<ShareResult> {
  const errors: string[] = [];
  let linked = 0;
  try {
    if (!(await io.exists(projectPath)))
      return { linked, skipped: "no-project-dir", errors };
    // Claude Code names the project by its working directory, which may be
    // the resolved path (on the NUC /Users/aitor is a link to /home/aitor).
    const real = (await resolved(io, projectPath)) ?? projectPath;
    const keys = [...new Set([projectKey(projectPath), projectKey(real)])];
    const targetProjects = await resolved(io, `${target}/projects`);
    let looked = false;
    let shared = false;
    for (const source of new Set(sources)) {
      if (source === target) continue;
      const sourceProjects = await resolved(io, `${source}/projects`);
      if (sourceProjects === null) continue;
      if (sourceProjects === targetProjects) {
        shared = true;
        continue;
      }
      looked = true;
      for (const key of keys) {
        linked += await shareKey(
          io,
          `${source}/projects/${key}`,
          `${target}/projects/${key}`,
          errors,
        );
      }
    }
    return { linked, skipped: shared && !looked ? "shared" : null, errors };
  } catch (error) {
    errors.push(message(error));
    return { linked, skipped: null, errors };
  }
}

/** One project key from one source: the sessions linked. */
async function shareKey(
  io: SessionsIo,
  from: string,
  to: string,
  errors: string[],
): Promise<number> {
  let entries: { name: string; directory: boolean }[];
  try {
    entries = await io.entries(from);
  } catch (error) {
    errors.push(`${from}: ${message(error)}`);
    return 0;
  }
  const sessions = new Set(
    entries.flatMap((e) => {
      const m = e.directory ? null : SESSION.exec(e.name);
      return m === null ? [] : [m[1]!];
    }),
  );
  const missing = async () => {
    const have = new Set((await io.entries(to)).map((e) => e.name));
    return entries.filter(
      (e) =>
        !have.has(e.name) &&
        (e.directory ? sessions.has(e.name) : SESSION.test(e.name)),
    );
  };
  let wanted: typeof entries;
  try {
    wanted = await missing();
    if (wanted.length === 0) return 0;
    await io.mkdir(to);
  } catch (error) {
    errors.push(`${to}: ${message(error)}`);
    return 0;
  }
  let linked = 0;
  // The sessions first: they are what `--resume` needs.
  for (const entry of wanted.sort(
    (a, b) => Number(a.directory) - Number(b.directory),
  )) {
    const source = `${from}/${entry.name}`;
    const path = `${to}/${entry.name}`;
    try {
      if (entry.directory) {
        await io.symlink(source, path);
        continue;
      }
      try {
        await io.link(source, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await io.copy(source, path);
      }
      linked += 1;
    } catch (error) {
      // Made meanwhile (another move, Claude Code itself): it is there.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      errors.push(`${path}: ${message(error)}`);
    }
  }
  return linked;
}
