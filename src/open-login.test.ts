import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HELPER = fileURLToPath(new URL("../bin/open-login.sh", import.meta.url));
const URL_OK = "https://claude.ai/oauth/authorize?x=1";

let base = "";
afterEach(async () => {
  if (base !== "") await rm(base, { recursive: true, force: true });
  base = "";
});

function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(HELPER, args, { env }, (error, _stdout, stderr) => {
      const code = error === null ? 0 : (error as { code?: number }).code;
      resolve({ code: typeof code === "number" ? code : -1, stderr });
    });
  });
}

/**
 * A Linux without a desktop: `uname` says Linux and `xdg-open` does what the
 * real one does there, which is to run $BROWSER with the address.
 */
async function linux(): Promise<{ env: Record<string, string>; log: string }> {
  base = await mkdtemp(join(tmpdir(), "open-login-"));
  const log = join(base, "opened");
  await writeFile(join(base, "uname"), "#!/bin/sh\necho Linux\n");
  await writeFile(
    join(base, "xdg-open"),
    [
      "#!/bin/sh",
      `echo "$1" >> "${log}"`,
      // Stops the test, not the helper: five rounds are a loop.
      `[ "$(wc -l < "${log}")" -ge 5 ] && exit 9`,
      'if [ -n "${BROWSER:-}" ]; then exec "$BROWSER" "$1"; fi',
      "exit 3",
      "",
    ].join("\n"),
  );
  await chmod(join(base, "uname"), 0o755);
  await chmod(join(base, "xdg-open"), 0o755);
  return { env: { PATH: `${base}:/usr/bin:/bin`, BROWSER: HELPER }, log };
}

describe("bin/open-login.sh", () => {
  it("opens nothing but an https address", async () => {
    const { env, log } = await linux();
    for (const args of [
      [],
      ["http://claude.ai/x"],
      ["file:///etc/passwd"],
      ["HTTPS://claude.ai/x"],
      ["javascript:alert(1)"],
      ["--args", URL_OK],
    ]) {
      const result = await run(args, env);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/not an https URL/);
    }
    await expect(readFile(log, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("hands the address to xdg-open once: xdg-open running $BROWSER does not come back here", async () => {
    // Claude Code runs this helper as $BROWSER, and xdg-open inherits it.
    const { env, log } = await linux();
    const result = await run([URL_OK], env);
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toEqual([
      URL_OK,
    ]);
    // xdg-open's own answer (nothing could open it) is the helper's.
    expect(result.code).toBe(3);
  });

  it("passes an address with spaces and quotes as one argument", async () => {
    const { env, log } = await linux();
    const odd = `https://claude.ai/x?a=1 2&b="c"&d='e' --args`;
    await run([odd], env);
    expect(await readFile(log, "utf8")).toBe(`${odd}\n`);
  });
});
