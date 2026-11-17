import type { MemorySettings, ProjectMemoryMode } from "@kovach-dev/memory-contract";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type AgentApi, type ComputerPermissions, MAX_STANDARDS_CHARS, type MediaStatusView, type ModelCheck, type ProjectInfo, type SettingsView } from "../../../shared/agent";
import type { HistoryApi } from "../../../shared/ipc";
import { errorText } from "../memory-format";

export function SettingsDialog(props: { agent: AgentApi; api: HistoryApi; projects?: ProjectInfo[]; onClose: () => void }) {
  const [tab, setTab] = useState<"model" | "tools" | "standards" | "memory">("model");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [removeKey, setRemoveKey] = useState(false);
  const [check, setCheck] = useState<ModelCheck | undefined>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void props.agent.getSettings().then((s) => {
      setBaseUrl(s.modelBaseUrl);
      setModel(s.model);
      setHasApiKey(s.hasApiKey);
      firstField.current?.focus();
    });
  }, [props.agent]);

  const save = async (useModel?: string) => {
    const key = removeKey ? "" : apiKey.trim() ? apiKey.trim() : undefined;
    const saved = await props.agent.saveSettings({ modelBaseUrl: baseUrl, model: useModel ?? model, ...(key !== undefined ? { apiKey: key } : {}) });
    setHasApiKey(saved.hasApiKey);
    setApiKey("");
    setRemoveKey(false);
  };

  const test = async (useModel?: string) => {
    setChecking(true);
    setError(undefined);
    try {
      if (useModel) setModel(useModel);
      await save(useModel);
      const result = await props.agent.checkModel();
      if (result.model) setModel(result.model);
      setCheck(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await save();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="overlay" onKeyDown={(e) => e.key === "Escape" && props.onClose()}>
      <form className="dialog settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" onSubmit={submit}>
        <h2 id="settings-title">Settings</h2>
        <div className="tabs" role="tablist" aria-label="Settings sections">
          <button type="button" role="tab" aria-selected={tab === "model"} className={tab === "model" ? "on" : ""} onClick={() => setTab("model")}>
            Model
          </button>
          <button type="button" role="tab" aria-selected={tab === "tools"} className={tab === "tools" ? "on" : ""} onClick={() => setTab("tools")}>
            Tools
          </button>
          <button type="button" role="tab" aria-selected={tab === "standards"} className={tab === "standards" ? "on" : ""} onClick={() => setTab("standards")}>
            Standards
          </button>
          <button type="button" role="tab" aria-selected={tab === "memory"} className={tab === "memory" ? "on" : ""} onClick={() => setTab("memory")}>
            Memory
          </button>
        </div>
        {tab === "memory" ? (
          <MemoryTab api={props.api} projects={props.projects ?? []} />
        ) : tab === "standards" ? (
          <StandardsTab agent={props.agent} />
        ) : tab === "tools" ? (
          <ToolsTab agent={props.agent} />
        ) : (
        <>
        <p className="meta">Local Kovach talks to a model server on this Mac (oMLX, or Ollama as a fallback).</p>
        <label className="field-label" htmlFor="model-url">
          Server address
        </label>
        <input id="model-url" ref={firstField} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
        <label className="field-label" htmlFor="model-name">
          Model
        </label>
        <input id="model-name" value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
        <label className="field-label" htmlFor="model-key">
          API key {hasApiKey ? "(saved)" : "(if the server needs one)"}
        </label>
        <input
          id="model-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasApiKey ? "Leave empty to keep the saved key" : "oMLX: Settings → Auth & Info"}
          autoComplete="off"
          spellCheck={false}
          disabled={removeKey}
        />
        {hasApiKey && (
          <label className="check-option">
            <input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} />
            Remove the saved key
          </label>
        )}
        <p className="meta">Stored encrypted with the macOS Keychain; it never leaves this Mac.</p>
        {check && (
          <p className={check.ok ? "check-ok" : "form-error"} role="status">
            {check.message}
          </p>
        )}
        {check && !check.ok && check.models && check.models.length > 0 && (
          <div className="model-choices" role="group" aria-label="Models on the server">
            {check.models.map((id) => (
              <button key={id} type="button" className="secondary" onClick={() => void test(id)} disabled={checking}>
                Use {id}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        </>
        )}
        <div className="form-actions">
          {tab === "model" && (
          <button type="button" className="secondary" onClick={() => void test()} disabled={checking}>
            {checking ? "Testing…" : "Test connection"}
          </button>
          )}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

/** The user's own engineering rules; the planner reads them before the built-in standards. */
function StandardsTab({ agent }: { agent: AgentApi }) {
  const [saved, setSaved] = useState<string | undefined>();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    void agent.getSettings().then((v) => {
      setSaved(v.standards);
      setText(v.standards);
    });
  }, [agent]);
  const save = async () => {
    if (text === saved) return;
    setError(undefined);
    try {
      const v = await agent.saveSettings({ standards: text });
      setSaved(v.standards);
      setText(v.standards);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  if (saved === undefined) return <p className="meta" aria-busy="true">Loading…</p>;
  const over = text.length > MAX_STANDARDS_CHARS;
  return (
    <div className="standards-tab">
      <p className="meta">
        Before each task, the agent restates your request as a brief and plans it against standards for that kind of work (web pages, React, Node,
        WordPress, Python; bug fixes, features, refactors). Rules you write here come first, in every project. A project's own rules belong in its
        AGENTS.md.
      </p>
      <label className="field-label" htmlFor="standards">
        Your standards
      </label>
      <textarea
        id="standards"
        rows={10}
        value={text}
        spellCheck={false}
        placeholder={"One rule per line, for example:\n- Mobile first; test at 360px wide\n- No jQuery; no new dependencies without asking\n- PHP: WordPress Coding Standards, every string translatable"}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void save()}
      />
      <p className={over ? "form-error" : "meta"} role={over ? "alert" : undefined}>
        {text.length.toLocaleString("en")} of {MAX_STANDARDS_CHARS.toLocaleString("en")} characters{text !== saved && !over ? " · saves when you leave the field" : ""}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ToolsTab({ agent }: { agent: AgentApi }) {
  const [s, setS] = useState<SettingsView | undefined>();
  const [searx, setSearx] = useState("");
  const [perms, setPerms] = useState<ComputerPermissions | undefined>();
  const [media, setMedia] = useState<MediaStatusView | undefined>();
  const [log, setLog] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void agent.getSettings().then((v) => {
      setS(v);
      setSearx(v.searxngUrl);
    });
    void agent.computerPermissions().then(setPerms);
    void agent.mediaStatus().then(setMedia);
    return agent.onMediaProgress((line) => setLog((l) => [...l.slice(-200), line]));
  }, [agent]);

  const save = async (patch: Partial<SettingsView>) => {
    setError(undefined);
    try {
      setS(await agent.saveSettings(patch));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!s) return <p className="meta" aria-busy="true">Loading…</p>;
  return (
    <div className="tools-tab">
      <section>
        <Switch label="Web search" checked={s.webSearch} onChange={(v) => void save({ webSearch: v })}>
          Lets the agent search the web and read pages (docs, error messages, versions).
        </Switch>
        {s.webSearch && (
          <div className="sub">
            <label className="field-label" htmlFor="searx">
              SearXNG address (optional)
            </label>
            <input
              id="searx"
              value={searx}
              placeholder="Empty uses a keyless DuckDuckGo fallback"
              spellCheck={false}
              onChange={(e) => setSearx(e.target.value)}
              onBlur={() => searx !== s.searxngUrl && void save({ searxngUrl: searx })}
            />
          </div>
        )}
      </section>

      <section>
        <Switch label="Computer use" checked={s.computerUse} onChange={(v) => void save({ computerUse: v })}>
          Lets a task see the screen and click, type and scroll, when you switch it on for that task. You approve every action.
        </Switch>
        {s.computerUse && perms && (
          <ul className="perm-list">
            {(
              [
                ["screenRecording", "Screen Recording"],
                ["accessibility", "Accessibility"],
              ] as const
            ).map(([key, label]) => (
              <li key={key}>
                <span className={perms[key] ? "ok" : "bad"}>{perms[key] ? "Granted" : "Not granted"}</span> {label}
                {!perms[key] && (
                  <button type="button" className="secondary small" onClick={() => void agent.openPermissionSettings(key)}>
                    Open System Settings
                  </button>
                )}
              </li>
            ))}
            {(!perms.screenRecording || !perms.accessibility) && (
              <li>
                <button type="button" className="ghost small" onClick={() => void agent.computerPermissions().then(setPerms)}>
                  Check again
                </button>
                <span className="meta"> macOS may ask you to reopen Local Kovach after granting Screen Recording.</span>
              </li>
            )}
          </ul>
        )}
      </section>

      <section>
        <Switch
          label="Image generation"
          checked={s.imageGeneration}
          disabled={media?.state !== "installed"}
          onChange={(v) => void save({ imageGeneration: v })}
        >
          Lets the agent create images (icons, mockups, illustrations) with FLUX.2 klein running on this Mac. About 5 GB to download.
        </Switch>
        {media && media.state !== "installed" && (
          <div className="sub">
            {media.state === "unsupported" ? (
              <p className="meta">{media.detail}</p>
            ) : (
              <>
                {media.detail && <p className="meta">{media.detail}</p>}
                <button
                  type="button"
                  className="secondary"
                  disabled={installing}
                  onClick={async () => {
                    setInstalling(true);
                    setLog([]);
                    setError(undefined);
                    try {
                      setMedia(await agent.installMedia());
                      setS(await agent.getSettings());
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setInstalling(false);
                    }
                  }}
                >
                  {installing ? "Installing…" : "Install image generation"}
                </button>
              </>
            )}
          </div>
        )}
        {media?.state === "installed" && (
          <p className="meta sub">
            Installed{media.detail ? ` (${media.detail})` : ""}. {media.modelDownloaded ? "Model downloaded." : "The model downloads with the first image."}
          </p>
        )}
        {log.length > 0 && (
          <pre className="install-log" aria-label="Install output">
            {log.join("\n")}
          </pre>
        )}
      </section>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const MODES: { value: ProjectMemoryMode; label: string }[] = [
  { value: "on", label: "On" },
  { value: "read_only", label: "Read only" },
  { value: "off", label: "Off" },
];

function MemoryTab({ api, projects }: { api: HistoryApi; projects: ProjectInfo[] }) {
  const [s, setS] = useState<MemorySettings | undefined>();
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then(
      (v) => {
        setS(v);
        setModel(v.embeddingModel);
      },
      (err) => setError(errorText(err)),
    );
  }, [api]);

  const save = async (patch: Partial<MemorySettings>) => {
    setError(undefined);
    setSaved(false);
    try {
      const next = await api.updateSettings(patch);
      setS(next);
      setModel(next.embeddingModel);
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (!s) {
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <p className="meta" aria-busy="true">
        Loading…
      </p>
    );
  }

  // Projects the agent knows, plus any that only have a saved mode.
  const list = [
    ...projects,
    ...Object.keys(s.projectModes)
      .filter((id) => !projects.some((p) => p.id === id))
      .map((id) => ({ id, name: id, path: "" })),
  ];

  return (
    <div className="tools-tab memory-tab">
      <section>
        <strong>Memory per project</strong>
        <p className="meta">
          <em>Read only</em> uses what is already remembered but saves nothing new. <em>Off</em> does neither, which suits client code.
        </p>
        {list.length === 0 ? (
          <p className="meta">Add a project from the start screen to choose its memory mode.</p>
        ) : (
          <ul className="mode-list">
            {list.map((p) => (
              <li key={p.id}>
                <label htmlFor={`mode-${p.id}`} title={p.path || undefined}>
                  {p.name}
                </label>
                <select
                  id={`mode-${p.id}`}
                  value={s.projectModes[p.id] ?? "on"}
                  onChange={(e) => void save({ projectModes: { ...s.projectModes, [p.id]: e.target.value as ProjectMemoryMode } })}
                >
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <Switch label="Learn from finished tasks automatically" checked={s.autoExtract} onChange={(v) => void save({ autoExtract: v })}>
          After a task, the agent proposes decisions and conventions worth keeping. Proposed memories wait in the Review tab.
        </Switch>
      </section>

      <section>
        <Switch
          label="Accept proposals that recur across sessions"
          checked={s.autoAcceptRecurring}
          onChange={(v) => void save({ autoAcceptRecurring: v })}
        >
          Keeps a proposal without asking once it comes up in more than one session. Until then, proposed memories wait in the Review tab.
        </Switch>
      </section>

      <section>
        <label className="field-label" htmlFor="embedding-model">
          Embedding model
        </label>
        <input
          id="embedding-model"
          value={model}
          spellCheck={false}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => model.trim() && model.trim() !== s.embeddingModel && void save({ embeddingModel: model.trim() })}
        />
        <p className="meta">Indexes memories for search. Use the model id as your model server lists it.</p>
      </section>

      {saved && !error && (
        <p className="visually-hidden" role="status">
          Memory settings saved
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Switch(props: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <div className="switch-row">
      <label className="switch">
        <input type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
        <span className="track" aria-hidden="true" />
        <strong>{props.label}</strong>
      </label>
      <p className="meta">{props.children}</p>
    </div>
  );
}
