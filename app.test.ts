import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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

// No DOM tests: guards that the panel writes its dates through src/panel.ts,
// in Madrid (Codex ULTRA-R2-005), never in the browser's zone.
describe("the panel's dates", () => {
  it("writes the history's times with moveTime and passes no browser zone", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(source).toContain("{moveTime(move.at)}");
    expect(source).not.toMatch(/toLocale(String|DateString|TimeString)\(/);
    expect(source).not.toContain("resolvedOptions().timeZone");
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

/**
 * bb's Icon lives in the host's runtime (SDK 0.6.15, experimental_Icon); the
 * SDK's own test runtime needs @testing-library/react, which this repo does
 * not carry: a bare stand-in is enough to read what a view says.
 */
async function withIcon() {
  const React = await import("react");
  const host = globalThis as { __bbPluginRuntime?: unknown };
  host.__bbPluginRuntime ??= {
    react: React,
    pluginSdkApp: {
      experimental_Icon: ({ name }: { name: string }) =>
        React.createElement("svg", { "data-icon": name, "aria-hidden": true }),
    },
  };
}

// Design B (0.2.32): the decisions live in src/panel.ts (tested there);
// these render app.tsx's views with the real reading of 2026-10-30 22:46
// (src/panel-fixture.ts) and read what is on screen.
describe("design B in Settings", () => {
  async function shown(lang: "es" | "en", paceHoldsBackground = true) {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    await withIcon();
    const { AccountsOverview } = await import("./app");
    const { realReading, READING_AT } = await import("./src/panel-fixture");
    const html = renderToStaticMarkup(
      createElement(AccountsOverview, {
        state: { ...realReading(), paceHoldsBackground },
        now: READING_AT,
        lang,
        timeZone: "Europe/Madrid",
        onLogin: () => {},
        onRefresh: () => {},
      }),
    );
    // Tags (and the titles inside them) out: only what is on screen.
    return { html, text: html.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'") };
  }

  it("says who works, who is kept and which has most week, then one row per account", async () => {
    const { html, text } = await shown("es");
    expect(text).toContain(
      "Trabajan studio, ganaresenas, team2, team4. Guardadas para ti: viaulab y aitor. La que más semana tiene es agency (100 %).",
    );
    expect(text).toContain("Ultra · lo que queda de la semana");
    expect(text).toContain("Team · lo que queda de sus 5 h");
    expect(text).toContain("88 % de la semana");
    expect(text).toContain("vuelve lun 09:00");
    expect(text).toContain("Guardada para ti · Ya ha gastado lo de hoy");
    expect(text).toContain("ha gastado el 89 % de Fable · 2 de 2 hilos · 4 esperando");
    expect(text).toContain("sin Fable hasta dom 22:00");
    // mariscal has no login: out, and the button to log it in.
    expect(text).toContain("Agotada · sin sesión iniciada");
    expect(text).toContain("Iniciar sesión");
    // Each bar is read out; the state is an icon and a word.
    expect(html).toContain('role="img" aria-label="Le queda el 2 % de la semana"');
    expect(html).toContain('class="whitespace-nowrap font-medium cs-s-kept"');
    // No jargon on screen (DISENO.md §Textos).
    for (const word of ["ses ", "sem ", "LOCKED", "seats", "weekly", "Weekly"])
      expect(text).not.toContain(word);
  });

  it("keeps nobody for the user with the brake on background work off (the default; Aitor 2026-10-31)", async () => {
    const { html, text } = await shown("es", false);
    expect(text).toContain(
      "Trabajan studio, ganaresenas, team2, team4. La que más semana tiene es agency (100 %).",
    );
    expect(text).not.toContain("Guardada");
    expect(html).not.toContain("cs-s-kept");
    // The day's share is still told.
    expect(text).toContain("Libre · Ya ha gastado lo de hoy");
    expect((await shown("en", false)).text).not.toContain("Kept for you");
  });

  it("speaks English to a browser that is not set to Spanish", async () => {
    const { text } = await shown("en");
    expect(text).toContain(
      "Working: studio, ganaresenas, team2, team4. Kept for you: viaulab and aitor. Most of the week left: agency (100 %).",
    );
    expect(text).toContain("88 % of the week");
    expect(text).toContain("back Mon 09:00");
    expect(text).toContain("Log in");
    expect(text).not.toContain("Trabajando");
  });

  it("keeps the projects by account, each heading with its account's line, and reads the language from the browser", async () => {
    const source = await readFile(new URL("./app.tsx", import.meta.url), "utf8");
    expect(source).toContain("projectsByAccount(state).map(");
    expect(source).toContain("row={rowOf(state, account, lang)}");
    expect(source).toContain("uiLang(typeof navigator === \"undefined\" ? undefined : navigator.language)");
    expect(source).toContain('import "./app.css";');
  });
});

describe("the thread's account in its menu", () => {
  it("shows the thread's account as a card with its figure, its line and the pace of its window", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { ThreadAccountCard } = await import("./app");
    const { accountRow } = await import("./src/panel");
    const { realReading, READING_AT } = await import("./src/panel-fixture");
    const state = realReading();
    const ctx = { now: READING_AT, lang: "es" as const, timeZone: "Europe/Madrid", preferredModel: "Fable" };
    const text = (name: string, forecast: string | null) =>
      renderToStaticMarkup(
        createElement(ThreadAccountCard, {
          row: accountRow(state.accounts.find((a) => a.name === name)!, state.seats?.[name], ctx),
          forecast,
        }),
      ).replace(/<[^>]*>/g, "");
    const aitor = text("aitor", null);
    expect(aitor).toContain("2 %");
    expect(aitor).toContain("Ultra · sin tope de 5 h · le queda el 2 % de la semana · vuelve dom 18:00");
    // The pace the card shows comes from the fixture's forecast, in Spanish.
    const { forecastText } = await import("./src/panel");
    const pace = forecastText(state.forecasts, "studio", "Fable", READING_AT, "es");
    expect(pace).toBe("Semana: llega al reinicio a este ritmo (24,3 %/día)");
    expect(text("studio", pace)).toContain("(24,3 %/día)");
  });
});
