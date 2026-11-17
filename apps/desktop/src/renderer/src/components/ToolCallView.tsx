import type { ToolCall } from "@kovach-dev/memory-contract";
import type { ReactNode } from "react";
import { BookIcon, CheckIcon, CursorIcon, EditIcon, FileIcon, GlobeIcon, ImageIcon, ListIcon, MonitorIcon, SearchSmallIcon, TerminalIcon, XIcon } from "./icons";
import { MdImage } from "./Markdown";

type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");

/** How a tool call reads in the transcript: an icon, a verb, its target and a short stat. */
export function describeCall(call: ToolCall): { icon: ReactNode; verb: string; target: string; stat?: string } {
  const a = (call.args ?? {}) as Args;
  switch (call.name) {
    case "read_file":
      return { icon: <FileIcon />, verb: "Read", target: str(a, "path") };
    case "list_files":
      return { icon: <ListIcon />, verb: "List", target: str(a, "filter") || "project files" };
    case "search":
      return { icon: <SearchSmallIcon />, verb: "Search", target: str(a, "pattern") };
    case "edit_file": {
      const edits = Array.isArray(a.edits) ? (a.edits as { old?: string; new?: string }[]) : [];
      // An insertion keeps its "old" anchor whole at the start or end of "new": only the new lines count.
      const inserts = (e: { old?: string; new?: string }) =>
        typeof e.old === "string" && typeof e.new === "string" && e.new.length > e.old.length && (e.new.startsWith(e.old) || e.new.endsWith(e.old));
      const added = edits.reduce((n, e) => n + (inserts(e) ? lineCount(e.new) - lineCount(e.old) : lineCount(e.new)), 0);
      const removed = edits.reduce((n, e) => n + (inserts(e) ? 0 : lineCount(e.old)), 0);
      return { icon: <EditIcon />, verb: "Edit", target: str(a, "path"), stat: `+${added} −${removed}` };
    }
    case "create_file":
      return { icon: <FileIcon />, verb: "Create", target: str(a, "path"), stat: `+${lineCount(str(a, "content"))}` };
    case "insert_lines":
      return { icon: <EditIcon />, verb: "Insert", target: `${str(a, "path")}${typeof a.afterLine === "number" ? ` after line ${a.afterLine}` : ""}`, stat: `+${lineCount(str(a, "content"))}` };
    case "run_command":
      return { icon: <TerminalIcon />, verb: "Run", target: call.command ?? str(a, "command") };
    case "run_checks":
      return { icon: <CheckIcon />, verb: "Checks", target: call.command ?? "typecheck, lint, test" };
    case "web_search":
      return { icon: <GlobeIcon />, verb: "Web search", target: str(a, "query") };
    case "fetch_page":
      return { icon: <GlobeIcon />, verb: "Fetch", target: str(a, "url") };
    case "computer_screenshot":
      return { icon: <MonitorIcon />, verb: "Screenshot", target: "" };
    case "search_docs":
      return { icon: <BookIcon />, verb: "Docs", target: str(a, "query") };
    case "self_review": {
      const files = Array.isArray(a.files) ? (a.files as string[]) : [];
      return { icon: <CheckIcon />, verb: "Review", target: files.length > 3 ? `${files.slice(0, 3).join(", ")} +${files.length - 3}` : files.join(", ") };
    }
    case "design_kit":
      return { icon: <FileIcon />, verb: "Design kit", target: `${str(a, "direction") || str(a, "business")} → ${str(a, "path") || "styles.css"}` };
    case "look_at_page":
      return { icon: <CheckIcon />, verb: "Look", target: str(a, "path") };
    case "find_symbol":
      return { icon: <SearchSmallIcon />, verb: "Find", target: str(a, "name") };
    case "find_references":
      return { icon: <SearchSmallIcon />, verb: "Uses of", target: str(a, "name") };
    case "diagnostics": {
      const paths = Array.isArray(a.paths) ? (a.paths as string[]) : [];
      return { icon: <CheckIcon />, verb: "Diagnostics", target: paths.length ? paths.join(", ") : "recent changes" };
    }
    case "computer_read_screen":
      return { icon: <MonitorIcon />, verb: "Read screen", target: "" };
    case "computer_open_app":
      return { icon: <MonitorIcon />, verb: "Open app", target: str(a, "name") };
    case "computer_drag":
      return { icon: <CursorIcon />, verb: "Drag", target: str(a, "note") || `${a.fromX}, ${a.fromY} → ${a.toX}, ${a.toY}` };
    case "computer_click":
      return { icon: <CursorIcon />, verb: "Click", target: str(a, "note") || (a.element !== undefined ? `element ${a.element}` : `${a.x}, ${a.y}`) };
    case "computer_type":
      return { icon: <CursorIcon />, verb: "Type", target: str(a, "text") };
    case "computer_key":
      return { icon: <CursorIcon />, verb: "Key", target: str(a, "combo") };
    case "computer_scroll":
      return { icon: <CursorIcon />, verb: "Scroll", target: `${a.x}, ${a.y}` };
    case "generate_image":
      return { icon: <ImageIcon />, verb: "Generate image", target: str(a, "path") };
    default:
      return { icon: <TerminalIcon />, verb: call.name, target: call.command ?? "" };
  }
}

const lineCount = (s: unknown) => (typeof s === "string" && s.length ? s.replace(/\n$/, "").split("\n").length : 0);

export function ToolCallView({ call }: { call: ToolCall }) {
  const d = describeCall(call);
  const running = call.exitCode === undefined;
  const failed = !running && call.exitCode !== 0;
  return (
    <details className={`tool${failed ? " failed" : ""}${running ? " running" : ""}`}>
      <summary>
        <span className="tool-icon">{d.icon}</span>
        <span className="tool-verb">{d.verb}</span>
        {d.target && <code className="tool-target">{d.target}</code>}
        {d.stat && <span className="tool-stat">{d.stat}</span>}
        <span className="tool-end">
          {call.durationMs !== undefined && <span className="meta">{formatDuration(call.durationMs)}</span>}
          {running ? (
            <span className="spinner" role="status" aria-label="Running" />
          ) : failed ? (
            <span className="exit bad" title={call.name === "self_review" ? "The review found problems to fix" : call.name === "look_at_page" ? "The browser measured problems" : `exit ${call.exitCode}`}>
              <XIcon /> {call.name === "self_review" || call.name === "look_at_page" ? "found problems" : `exit ${call.exitCode}`}
            </span>
          ) : (
            <span className="exit ok" aria-label="Succeeded">
              <CheckIcon />
            </span>
          )}
        </span>
      </summary>
      <div className="tool-body">
        <ToolBody call={call} />
      </div>
    </details>
  );
}

function ToolBody({ call }: { call: ToolCall }) {
  const a = (call.args ?? {}) as Args;
  const { text, images } = splitImages(call.outputExcerpt ?? "");
  const parts: ReactNode[] = [];
  if (call.name === "edit_file" && Array.isArray(a.edits)) {
    parts.push(
      ...(a.edits as { old?: string; new?: string }[]).map((e, i) => <Diff key={`d${i}`} before={e.old ?? ""} after={e.new ?? ""} />),
    );
  } else if (call.name === "create_file" || call.name === "insert_lines") {
    parts.push(<Diff key="c" before="" after={str(a, "content")} />);
  }
  if (images.length) {
    parts.push(
      <div key="imgs" className="tool-images">
        {images.map((img) => (
          <MdImage key={img.src} alt={img.alt} src={img.src} />
        ))}
      </div>,
    );
  }
  if (text.trim() && call.name !== "create_file") parts.push(<pre key="out" className="tool-output">{text.trim()}</pre>);
  if (call.outputPath) parts.push(<p key="more" className="meta">Showing the first 8 KB. The full output is kept on disk.</p>);
  if (!parts.length) parts.push(<p key="none" className="meta">{call.exitCode === undefined ? "Running…" : "No output."}</p>);
  return <>{parts}</>;
}

/** Pull `![alt](attachment:…)` links out of tool output so they show as pictures. */
export function splitImages(output: string): { text: string; images: { alt: string; src: string }[] } {
  const images: { alt: string; src: string }[] = [];
  const text = output.replace(/!\[([^\]]*)\]\((attachment:[^)\s]+)\)/g, (_m, alt: string, src: string) => {
    images.push({ alt, src });
    return "";
  });
  return { text, images };
}

/** A simple line diff of one search/replace block: shared lines at the edges are context. */
export function Diff({ before, after }: { before: string; after: string }) {
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after ? after.replace(/\n$/, "").split("\n") : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const rows: { kind: " " | "-" | "+"; text: string }[] = [
    ...a.slice(0, start).map((t) => ({ kind: " " as const, text: t })),
    ...a.slice(start, endA).map((t) => ({ kind: "-" as const, text: t })),
    ...b.slice(start, endB).map((t) => ({ kind: "+" as const, text: t })),
    ...a.slice(endA).map((t) => ({ kind: " " as const, text: t })),
  ];
  return (
    <pre className="diff" aria-label="Changes">
      {rows.map((r, i) => (
        <span key={i} className={r.kind === "+" ? "add" : r.kind === "-" ? "del" : "ctx"}>
          <span className="sign" aria-hidden="true">
            {r.kind}
          </span>
          {r.text || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
