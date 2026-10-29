import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

// app.tsx has no DOM tests (see README, Development); this guards the r3
// regression where two empty-state blocks were pasted twice.
describe("app.tsx", () => {
  it("renders each empty state once, and the no-login one only when no account is logged in", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(source.split("No projects yet.")).toHaveLength(2);
    expect(source.split("No Claude Code login found")).toHaveLength(2);
    // The default account is always listed, so "no accounts" never happens:
    // the message is for "no account is logged in".
    expect(source).not.toContain("state.accounts.length === 0");
    expect(source).toContain("noLoginFound(state.accounts)");
  });
});

// The thread header vanished whenever its reads were slow or failed (bb
// busy, 2026-10-02): no DOM tests here, so these guard the two fixes.
describe("the thread header's reads", () => {
  it("starts from the last list any view saw, and retries a failed read instead of staying empty", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(source).toContain("useState<State | null>(lastSeen)");
    expect(source).toContain("lastSeen = shown;");
    // accounts_list and threads.get both try again after a failure (and
    // the advice banner's thread_advice, Sol B2-004).
    expect(source.split("retryDelayMs(")).toHaveLength(4);
    // A thread keeps its provider: asked once per thread.
    expect(source).toContain("claudeThreads.set(threadId, claude)");
  });
});

// The new-thread control (0.2.9): no DOM tests here either, so these guard
// its wiring to the helpers tested in src/ui.test.ts.
describe("the new-thread account control", () => {
  it("lets a pick of the shown account keep it, follows the compact layout and asks for a missing project", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(source).toContain("picksOnSelect(account.name, status.account, newThread)");
    expect(source).toContain('isCompactViewport={composer.layout === "compact" || narrow}');
    // The composer's pickers decide whether the control shows (another provider hides it).
    expect(source).toContain("composerProject(composer.scope, composer.selection)");
    expect(source).toContain("const narrow = useIsCompactViewport();");
    // Back to the draft when the menu closes, and the host form's mousedown
    // kept out of the menu.
    expect(source).toContain("focusComposer={() => composer.focus()}");
    expect(source).toContain(`                if (active !== null && active !== document.body) return;
                event.preventDefault();
                focusComposer();`);
    expect(source).toContain("onMouseDown={newThread ? (event) => event.stopPropagation() : undefined}");
    expect(source).toContain("aria-describedby={keepsHelp ? helpId : undefined}");
    expect(source).toContain('<span id={helpId} className="block">');
    // ...and again after a failed read (askForProject, src/ui.test.ts): the
    // whole effect, its condition and its dependencies.
    expect(source).toContain(`    if (!missing) return;
    return askForProject(
      () => readProject(projectId),
      failedReads,
      () => setFailedReads((n) => n + 1),
    );
  }, [missing, projectId, readProject, failedReads]);`);
    // bb's input lock only stops typing, not a send: not used (DESIGN).
    expect(source).not.toContain("setInputLock");
    // Every read and change takes a ticket, so a late answer to an older
    // request cannot put back the account a project had before a pick.
    expect(source.split("const ticket = answers.start();")).toHaveLength(4);
    expect(source.split("keep(ticket, ")).toHaveLength(4);
    // The ticket is taken before the change is sent, not after it answers.
    expect(source).toContain(`      const ticket = answers.start();
      try {
        keep(ticket, await work());`);
    expect(source).toContain("const shown = keep(ticket, next);");
    expect(source).toContain("return projectRead(next, shown, project);");
    expect(source).toContain("const shown = answers.accept(ticket, next);");
    // The composer sits in bb's <form>, and the mobile menu trigger sets no
    // type of its own: without this, opening the menu sends the draft.
    expect(source).toMatch(/<DropdownMenuTrigger asChild>\s+<Button\s+type="button"/);
    expect(source).toContain("const keepsHelp = newThread && state.autoSwitch && !status.external;");
    expect(source).toContain("key={projectId}");
    expect(source).toContain('rpc.call("accounts_list", { project })');
    expect(source).not.toContain("account.name !== status.account)");
  });
});

// The host hands setup() an `app` whose slots are functions; a host that
// predates (or drops) an experimental slot simply lacks that member.
async function register(slotNames: string[], withComposer = false) {
  const { default: definition } = await import("./app.tsx");
  const registered: { slot: string; id: string; title: string; component: unknown }[] = [];
  const slots = Object.fromEntries(
    slotNames.map((name) => [
      name,
      (r: { id: string; title: string; component: unknown }) =>
        registered.push({
          slot: name,
          id: r.id,
          title: r.title,
          // The component by name, as the plugin definition registers it.
          component: (r.component as { name?: string }).name,
        }),
    ]),
  );
  const setup = (definition as unknown as { setup: (app: unknown) => void }).setup;
  // The composer's customizations, as the host receives them.
  type Part = { id: string; component: unknown };
  const customized: { id: string; scopes: unknown; actions?: Part[]; banners?: Part[] }[] = [];
  const named = (parts: Part[]) =>
    parts.map((a) => ({ id: a.id, component: (a.component as { name?: string }).name }));
  const composer = withComposer
    ? {
        customize: (r: { id: string; scopes?: unknown; actions?: Part[]; banners?: Part[] }) =>
          customized.push({
            id: r.id,
            scopes: r.scopes,
            ...(r.actions === undefined ? {} : { actions: named(r.actions) }),
            ...(r.banners === undefined ? {} : { banners: named(r.banners) }),
          }),
      }
    : undefined;
  setup({ slots, composer });
  return { registered, customized };
}

describe("the plugin's frontend registration", () => {
  it("registers the Settings section and the thread header control", async () => {
    const { registered } = await register(["settingsSection", "experimental_threadHeaderAction"]);
    expect(registered).toEqual([
      { slot: "settingsSection", id: "claude-switcher", title: "Claude Switcher", component: "AccountsSection" },
      { slot: "experimental_threadHeaderAction", id: "claude-account", title: "Claude account", component: "ThreadAccount" },
    ]);
  });

  it("puts the account control in the new-thread composer, and only there; the Opus advice over a thread's composer (Sol B2-004)", async () => {
    const { customized } = await register(["settingsSection"], true);
    expect(customized).toEqual([
      { id: "claude-account", scopes: ["new-thread"], actions: [{ id: "claude-account", component: "NewThreadAccount" }] },
      { id: "claude-opus-advice", scopes: ["thread"], banners: [{ id: "claude-opus-advice", component: "ThreadAdvice" }] },
    ]);
  });

  it("the advice banner reads its own thread's advice, again on that thread's signal, and drops an answer for a thread it no longer shows (Sol B2-004)", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    const { ADVICE_CHANGED } = await import("./server.ts");
    // The channel the server signals on, literal in the app (server code is never bundled there).
    expect(source).toContain(`useRealtime("${ADVICE_CHANGED}", (payload) => {`);
    expect(source).toContain(
      'const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;',
    );
    expect(source).toContain('rpc.call("thread_advice", { threadId })');
    expect(source).toContain("(payload as { threadId?: unknown } | null)?.threadId === threadId");
    expect(source).toContain("if (shown === null || shown.threadId !== threadId || shown.text === null)");
    // A failed read is tried again, as the header's are.
    expect(source).toContain("timer = setTimeout(ask, retryDelayMs(attempt++))");
    // It only shows: nothing in it sends, queues or changes the thread.
    const banner = source.slice(source.indexOf("function ThreadAdvice()"), source.indexOf("export default definePluginApp"));
    expect(banner).not.toMatch(/threads\.(send|retry|update)|queuedMessages|setProjectAccount/);
  });

  it("the advice banner reads again when bb's connection is back: a signal that added or took away the advice while it was down is lost (Sol B2-R2-004)", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    const banner = source.slice(source.indexOf("function ThreadAdvice()"), source.indexOf("export default definePluginApp"));
    // The connection's change decides (signalsBack, tested in src/ui.test.ts)...
    expect(banner).toContain("const connection = useRealtimeConnectionState();");
    expect(banner).toContain("if (signalsBack(seen.current, connection)) setSignals((n) => n + 1);");
    expect(banner).toContain("seen.current = connection;");
    expect(banner).toContain("}, [connection]);");
    // ...and counts as a signal: the read starts afresh, and the answer of
    // a read begun before is dropped (`live`).
    expect(banner).toContain("}, [rpc, threadId, signals]);");
    expect(banner).toContain("if (live) setShown({ threadId, text });");
    expect(banner).toContain("live = false;");
  });

  it("keeps the other controls on a host without composer customization", async () => {
    const { registered, customized } = await register(["settingsSection", "experimental_threadHeaderAction"]);
    expect(customized).toEqual([]);
    expect(registered.map((r) => r.slot)).toEqual(["settingsSection", "experimental_threadHeaderAction"]);
  });

  it("keeps the Settings section on a host without the experimental thread header slot", async () => {
    const { registered } = await register(["settingsSection"]);
    expect(registered.map((r) => `${r.slot}:${r.id}`)).toEqual(["settingsSection:claude-switcher"]);
  });
});

// The compact panel (0.2.30): the decisions live in src/ui.ts (tested
// there); these guard that app.tsx draws from them.
describe("the compact accounts panel", () => {
  it("draws each card's bars from accountWindows in one thin row, says when an account is out, and groups the projects by account", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    // No weekly bar of its own: a Team seat has none (accountWindows).
    expect(source).not.toContain('label="Weekly (all models)"');
    expect(source).toContain("accountWindows(usage).map(");
    expect(source).toContain('className="mt-1 flex gap-1"');
    expect(source).toContain("outText(summary.outUntil, now)");
    expect(source).toContain("projectsByAccount(state).map(");
    // The menu's line has no weekly for a Team seat either.
    expect(source).toContain("account.usage.weekly.absent === true");
  });
});

describe("an account's row in the panel (Codex E46-R6-003)", () => {
  it("writes when each window resets and the pace that matters as text, not only in titles a keyboard or a touch never opens", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { UsageRow } = await import("./app");
    const NOW = Date.UTC(2026, 9, 29, 12, 0);
    const H = 3_600_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const text = (props: Parameters<typeof UsageRow>[0]) =>
        // Tags (and the titles inside them) out: only what is on screen.
        renderToStaticMarkup(createElement(UsageRow, props)).replace(/<[^>]*>/g, "");
      const shown = text({
        usage: {
          blocked: false,
          session: { usedPercent: 40, resetsAt: NOW + 2 * H + 10 * 60_000 },
          weekly: { usedPercent: 30, resetsAt: NOW + 76 * H },
          models: { Fable: { usedPercent: 70, resetsAt: NOW + 26 * H } },
        },
        preferredModel: "Fable",
        forecasts: {
          weekly: { kind: "lasts", until: NOW + 76 * H, percentPerDay: 5 },
          Fable: { kind: "runs-out", at: NOW + 20 * H, percentPerDay: 30 },
        },
      });
      expect(shown).toContain("ses 40%");
      expect(shown).toContain(
        "resets ses 2 h 10 min, sem 3 d 4 h, Fable 1 d 2 h · Fable runs out in 20 h at this pace (30 %/day)",
      );
      // A Team seat: no weekly, and nothing to pace.
      const seat = text({
        usage: {
          blocked: false,
          session: { usedPercent: 5, resetsAt: NOW + 4 * H },
          weekly: { usedPercent: 0, resetsAt: null, absent: true },
          models: {},
        },
        preferredModel: "Fable",
        forecasts: undefined,
      });
      expect(seat).toContain("resets ses 4 h 0 min");
      expect(seat).not.toContain("sem");
      expect(seat).not.toContain("runs out");
    } finally {
      vi.useRealTimers();
    }
  });
});
