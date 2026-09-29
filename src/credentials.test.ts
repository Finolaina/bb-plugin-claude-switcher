import { describe, expect, it } from "vitest";
import {
  accessToken,
  fetchUsage,
  keychainService,
  type CredentialIo,
  type PendingCredentials,
} from "./credentials.js";

const NOW = Date.parse("2026-09-29T10:00:00.000Z");
// The keychain rule (first 8 hex of the path's SHA-256) was checked
// against a real machine's items (Claude Code 2.1.x). The expected name
// below was computed independently: printf %s "$DIR" | shasum -a 256
const DIR = "/Users/someone/.claude-accounts/work";

function cred(expiresAt: number | undefined, token = "tok-old") {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: "ref-old",
      ...(expiresAt === undefined ? {} : { expiresAt }),
      scopes: ["user:profile"],
    },
  });
}

function rotated(access = "tok-new", refresh: string | null = "ref-new") {
  return Response.json({
    access_token: access,
    ...(refresh === null ? {} : { refresh_token: refresh }),
    expires_in: 3600,
  });
}

function fakeIo(
  overrides: Partial<CredentialIo> & {
    store?: Map<string, string>;
    /** Exit code of add-generic-password (0 = writes into the store). */
    addCode?: number;
  } = {},
) {
  const store = overrides.store ?? new Map<string, string>();
  const calls: string[][] = [];
  const posted: string[] = [];
  const io: CredentialIo = {
    platform: "darwin",
    username: "someone",
    home: "/Users/someone",
    async exec(args) {
      calls.push(args);
      const service = args[args.indexOf("-s") + 1]!;
      if (args[0] === "find-generic-password") {
        const value = store.get(service);
        return value === undefined
          ? { code: 44, stdout: "" }
          : { code: 0, stdout: `${value}\n` };
      }
      if (args[0] === "add-generic-password") {
        if ((overrides.addCode ?? 0) !== 0)
          return { code: overrides.addCode!, stdout: "" };
        const hex = args[args.indexOf("-X") + 1]!;
        store.set(service, Buffer.from(hex, "hex").toString("utf8"));
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    },
    async readFile() {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    async writeFile() {},
    fetch: async (_url, init) => {
      posted.push(JSON.parse(String(init?.body)).refresh_token);
      return rotated();
    },
    ...overrides,
  };
  return { io, store, calls, posted };
}

describe("keychainService", () => {
  it("is the plain service for the default dir and sha256(NFC(dir))[:8] otherwise", () => {
    expect(keychainService(null)).toBe("Claude Code-credentials");
    // Same value Claude Code 2.1.x computes for this dir.
    expect(keychainService(DIR)).toBe("Claude Code-credentials-ce42d15f");
    expect(keychainService("/tmp/café")).toBe(keychainService("/tmp/café"));
  });
});

describe("accessToken", () => {
  it("returns the stored token while it is still valid (expiry == now included), without touching the network", async () => {
    const { io, store, posted } = fakeIo();
    store.set(keychainService(DIR), cred(NOW));
    expect(await accessToken(io, DIR, NOW)).toEqual({
      token: "tok-old",
      refreshed: false,
      unsaved: null,
    });
    expect(posted).toEqual([]);
  });

  it("refreshes an expired token, writes it back and re-reads to verify", async () => {
    let body: unknown = null;
    const { io, store, calls } = fakeIo({
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        expect(init?.redirect).toBe("error");
        return rotated();
      },
    });
    store.set(keychainService(DIR), cred(NOW - 1));
    expect(await accessToken(io, DIR, NOW)).toEqual({
      token: "tok-new",
      refreshed: true,
      unsaved: null,
    });
    expect(body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "ref-old",
    });
    const written = JSON.parse(store.get(keychainService(DIR))!);
    expect(written.claudeAiOauth).toMatchObject({
      accessToken: "tok-new",
      refreshToken: "ref-new",
      expiresAt: NOW + 3_600_000,
      scopes: ["user:profile"],
    });
    expect(calls.map((c) => c[0])).toEqual([
      "find-generic-password",
      "add-generic-password",
      "find-generic-password",
    ]);
  });

  it("verifies the write by its tokens, not by the byte order of the JSON", async () => {
    const { io, store } = fakeIo({
      exec: async (args) => {
        if (args[0] === "find-generic-password")
          return {
            code: 0,
            stdout: store.get(keychainService(DIR)) ?? "",
          };
        // Writes the same login with the keys in another order.
        const hex = args[args.indexOf("-X") + 1]!;
        const json = JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
        const { accessToken: a, ...rest } = json.claudeAiOauth;
        store.set(
          keychainService(DIR),
          JSON.stringify({ claudeAiOauth: { ...rest, accessToken: a } }),
        );
        return { code: 0, stdout: "" };
      },
    });
    store.set(keychainService(DIR), cred(NOW - 1));
    expect(await accessToken(io, DIR, NOW)).toMatchObject({ unsaved: null });
  });

  it("keeps a rotated login the store rejected, reports it, and writes it once the store works again", async () => {
    const pending: PendingCredentials = new Map();
    const { io, store, posted } = fakeIo({ addCode: 1 });
    store.set(keychainService(DIR), cred(NOW - 1));
    const first = await accessToken(io, DIR, NOW, pending);
    expect(first).toMatchObject({
      token: "tok-new",
      refreshed: true,
      unsaved: expect.stringMatching(/security exited 1/),
    });
    // Still valid: no second refresh, no new token consumed; the write is retried.
    const stillBroken = await accessToken(io, DIR, NOW + 1, pending);
    expect(stillBroken).toMatchObject({
      token: "tok-new",
      unsaved: expect.any(String),
    });
    expect(posted).toEqual(["ref-old"]);
    // The store works again: written and verified, nothing pending.
    const healed = fakeIo({ store, fetch: io.fetch });
    expect(await accessToken(healed.io, DIR, NOW + 2, pending)).toEqual({
      token: "tok-new",
      refreshed: true,
      unsaved: null,
    });
    expect(
      JSON.parse(store.get(keychainService(DIR))!).claudeAiOauth.refreshToken,
    ).toBe("ref-new");
    expect(pending.size).toBe(0);
  });

  it("refreshes an expired unsaved login with ITS refresh token, never the consumed one", async () => {
    const pending: PendingCredentials = new Map();
    const { io, store, posted } = fakeIo({ addCode: 1 });
    store.set(keychainService(DIR), cred(NOW - 1));
    await accessToken(io, DIR, NOW, pending);
    const later = NOW + 3_600_001;
    expect(await accessToken(io, DIR, later, pending)).toMatchObject({
      token: "tok-new",
    });
    expect(posted).toEqual(["ref-old", "ref-new"]);
  });

  it("drops an unsaved login when the store was rotated by someone else meanwhile", async () => {
    const pending: PendingCredentials = new Map();
    const { io, store, posted } = fakeIo({ addCode: 1 });
    store.set(keychainService(DIR), cred(NOW - 1));
    await accessToken(io, DIR, NOW, pending);
    // The CLI logged in again: a different refresh token is in the store.
    store.set(
      keychainService(DIR),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok-cli",
          refreshToken: "ref-cli",
          expiresAt: NOW + 10,
        },
      }),
    );
    expect(await accessToken(io, DIR, NOW + 1, pending)).toEqual({
      token: "tok-cli",
      refreshed: false,
      unsaved: null,
    });
    expect(posted).toEqual(["ref-old"]);
    expect(pending.size).toBe(0);
  });

  it("reports an unverifiable write instead of throwing, and keeps the login pending", async () => {
    const pending: PendingCredentials = new Map();
    const { io } = fakeIo({
      exec: async (args) => {
        if (args[0] === "find-generic-password")
          return { code: 0, stdout: cred(NOW - 1) };
        return { code: 0, stdout: "" }; // pretends to write, keeps the old value
      },
    });
    expect(await accessToken(io, DIR, NOW, pending)).toMatchObject({
      token: "tok-new",
      unsaved: expect.stringMatching(/verify/),
    });
    expect(pending.size).toBe(1);
  });

  it("keeps rotated tokens from a 200 without expires_in and treats the access token as expired", async () => {
    const pending: PendingCredentials = new Map();
    const { io, store, posted } = fakeIo({
      fetch: async (_url, init) => {
        posted.push(JSON.parse(String(init?.body)).refresh_token);
        return Response.json({
          access_token: "tok-new",
          refresh_token: "ref-new",
        });
      },
    });
    store.set(keychainService(DIR), cred(NOW - 1));
    expect(await accessToken(io, DIR, NOW, pending)).toMatchObject({
      token: "tok-new",
    });
    expect(
      JSON.parse(store.get(keychainService(DIR))!).claudeAiOauth,
    ).toMatchObject({
      refreshToken: "ref-new",
      expiresAt: NOW,
    });
    // Next call: expired at once, so it refreshes again with the NEW token.
    await accessToken(io, DIR, NOW + 1, pending);
    expect(posted).toEqual(["ref-old", "ref-new"]);
  });

  it("keeps a pending rotated login when the store is unreadable for a call, and when its own refresh hits a transient 4xx", async () => {
    const pending: PendingCredentials = new Map();
    const { io, store } = fakeIo({ addCode: 1 });
    const service = keychainService(DIR);
    store.set(service, cred(NOW - 1));
    expect(await accessToken(io, DIR, NOW, pending)).toMatchObject({
      token: "tok-new",
    });
    // Store unreadable this time (item not found): nothing proves ref-new is dead.
    const kept = store.get(service)!;
    store.delete(service);
    expect(await accessToken(io, DIR, NOW + 1, pending)).toBeNull();
    store.set(service, kept);
    expect(pending.get(service)?.credentials.claudeAiOauth.refreshToken).toBe(
      "ref-new",
    );
    // The pending login expires; its refresh meets a 429: an outage, not a logout.
    io.fetch = async () => new Response("slow down", { status: 429 });
    await expect(
      accessToken(io, DIR, NOW + 3_600_001, pending),
    ).rejects.toThrow(/429/);
    expect(pending.get(service)?.credentials.claudeAiOauth.refreshToken).toBe(
      "ref-new",
    );
  });

  it("returns null when there is no login (and never refreshes)", async () => {
    const { io, posted } = fakeIo();
    expect(await accessToken(io, DIR, NOW)).toBeNull();
    expect(posted).toEqual([]);
  });

  it("returns null when the provider rejects the refresh token (the login is gone)", async () => {
    const { io, store } = fakeIo({
      fetch: async () =>
        new Response('{"error":"invalid_grant"}', { status: 400 }),
    });
    store.set(keychainService(DIR), cred(NOW - 1));
    expect(await accessToken(io, DIR, NOW)).toBeNull();
  });

  it("throws on a token endpoint outage or an unreadable body: not a logout", async () => {
    const { io, store } = fakeIo({
      fetch: async () => new Response("", { status: 503 }),
    });
    store.set(keychainService(DIR), cred(NOW - 1));
    await expect(accessToken(io, DIR, NOW)).rejects.toThrow(/503/);
    const cut = fakeIo({
      fetch: async () => new Response("{", { status: 200 }),
    });
    cut.store.set(keychainService(DIR), cred(NOW - 1));
    await expect(accessToken(cut.io, DIR, NOW)).rejects.toThrow(/unreadable/);
  });

  it("throws when the keychain cannot be read (any exit but 0 and 44)", async () => {
    const { io } = fakeIo({
      exec: async () => ({ code: -1, stdout: "" }),
    });
    await expect(accessToken(io, DIR, NOW)).rejects.toThrow(
      /security exited -1/,
    );
  });

  it("falls back to the credentials file inside the dir off macOS, under HOME for the default dir", async () => {
    const paths: string[] = [];
    const { io } = fakeIo({
      platform: "linux",
      home: "/home/someone",
      readFile: async (path) => {
        paths.push(path);
        return cred(NOW + 1, "tok-file");
      },
    });
    expect(await accessToken(io, DIR, NOW)).toEqual({
      token: "tok-file",
      refreshed: false,
      unsaved: null,
    });
    expect(await accessToken(io, null, NOW)).toMatchObject({
      token: "tok-file",
    });
    expect(paths).toEqual([
      `${DIR}/.credentials.json`,
      "/home/someone/.claude/.credentials.json",
    ]);
    const denied = fakeIo({
      platform: "linux",
      readFile: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    await expect(accessToken(denied.io, DIR, NOW)).rejects.toThrow(/EACCES/);
  });
});

describe("fetchUsage", () => {
  it("sends the bearer token with the oauth beta header and follows no redirect", async () => {
    let seen: Headers | null = null;
    let redirect: string | undefined;
    const { io } = fakeIo({
      fetch: async (_url, init) => {
        seen = new Headers(init?.headers);
        redirect = init?.redirect;
        return Response.json({ limits: [] });
      },
    });
    expect(await fetchUsage(io, "tok")).toEqual({
      status: "ok",
      payload: { limits: [] },
    });
    expect(seen!.get("authorization")).toBe("Bearer tok");
    expect(seen!.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(redirect).toBe("error");
  });

  it("distinguishes 429, 401 and other failures", async () => {
    const statuses = [429, 401, 503];
    const { io } = fakeIo({
      fetch: async () => new Response("", { status: statuses.shift() }),
    });
    expect(await fetchUsage(io, "tok")).toEqual({ status: "rate-limited" });
    expect(await fetchUsage(io, "tok")).toEqual({ status: "unauthenticated" });
    expect(await fetchUsage(io, "tok")).toMatchObject({ status: "error" });
  });
});
