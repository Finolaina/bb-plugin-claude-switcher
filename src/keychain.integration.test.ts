// The default account (`~/.claude`, configDir null) measured through the
// REAL keychain and usage endpoint of this Mac, as the plugin's server does
// (Aitor 2026-10-30, Añadido 2: «mariscal not logged in» while `claude auth
// status` said logged in). Off unless asked for, and never in CI:
//
//   CLAUDE_SWITCHER_KEYCHAIN=1 npx vitest run src/keychain.integration.test.ts
//
// Read only: a refresh is refused before it reaches the network (it would
// rotate the refresh token under a running bb and log the account out) and
// so is any write to the keychain. Prints which step failed, never a token.
import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { UsageCollector } from "./collector.js";
import { TOKEN_URL, type CredentialIo } from "./credentials.js";
import { nodeCredentialIo } from "./node-io.js";

const ON =
  process.env.CLAUDE_SWITCHER_KEYCHAIN === "1" && platform() === "darwin";

describe.runIf(ON)("the default account through this Mac's keychain", () => {
  it("is logged in, as `claude auth status` says", async () => {
    const real = nodeCredentialIo();
    const steps: string[] = [];
    const io: CredentialIo = {
      ...real,
      async exec(args) {
        if (args[0] !== "find-generic-password") {
          steps.push(`security ${args[0]}: refused by the test`);
          return { code: 1, stdout: "" };
        }
        const result = await real.exec(args);
        const shown = args.filter((a) => a !== "-w").join(" ");
        steps.push(
          `security ${shown}: rc ${result.code}, ${result.stdout.length} chars`,
        );
        return result;
      },
      async fetch(input, init) {
        if (String(input) === TOKEN_URL) {
          steps.push("refresh: refused by the test (the stored token expired)");
          throw new Error("refresh refused by the test");
        }
        const response = await real.fetch(input, init);
        steps.push(`GET ${String(input)}: HTTP ${response.status}`);
        return response;
      },
    };
    const warnings: string[] = [];
    const collector = new UsageCollector({
      io,
      now: Date.now,
      warn: (message) => warnings.push(message),
    });
    const measurement = await collector.collect({
      name: "default",
      configDir: null,
      email: null,
      accountUuid: null,
    });
    console.log(
      JSON.stringify(
        {
          username: real.username,
          steps,
          warnings,
          problem: measurement.problem,
          login: measurement.login,
          observedAt: measurement.observedAt,
        },
        null,
        2,
      ),
    );
    expect(measurement.login).toBe("yes");
    expect(measurement.problem).toBeNull();
  });
});
