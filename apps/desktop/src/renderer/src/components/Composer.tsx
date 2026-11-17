import { type ClipboardEvent, type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";
import type { AgentApi, ImageAttachment, ProjectInfo } from "../../../shared/agent";
import type { QueuedMessage } from "../queue";
import { ArrowUpIcon, MonitorIcon, PaperclipIcon, StopIcon, XIcon } from "./icons";

const TYPES: ImageAttachment["mediaType"][] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_BYTES = 10 * 1024 * 1024;

export interface ComposerSubmit {
  text: string;
  images: ImageAttachment[];
  computerUse: boolean;
  allowFailingChecks: boolean;
}

export interface ComposerProps {
  agent: AgentApi;
  /** New sessions pick a project (or none); continuing sessions show theirs. */
  mode: "new" | "continue";
  projects?: ProjectInfo[];
  projectId?: string | undefined;
  onProjectChange?: (id: string | undefined) => void;
  onAddProject?: () => Promise<ProjectInfo | undefined>;
  /** Why sending is blocked right now, if it is. */
  disabledReason?: string | undefined;
  running?: boolean;
  onStop?: () => void;
  /** A task is running somewhere: sending puts the message in the queue instead. */
  queueing?: boolean;
  onQueue?: (input: ComposerSubmit) => void;
  /** Messages waiting for this composer's session (or, on the start screen, new tasks). */
  queued?: QueuedMessage[];
  onUnqueue?: (id: string) => void;
  /** The queue stopped because the user stopped a task; it waits to be told to go on. */
  queuePaused?: boolean;
  queueError?: string | undefined;
  onResumeQueue?: () => void;
  computerUse: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit: (input: ComposerSubmit) => Promise<void>;
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<(ImageAttachment & { url: string })[]>([]);
  const [computer, setComputer] = useState(false);
  const [allowFailing, setAllowFailing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.autoFocus) area.current?.focus();
  }, [props.autoFocus]);

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  /** Sending now would wait in the queue. */
  const queues = !!props.onQueue && (!!props.running || !!props.queueing);
  const blocked = !!props.disabledReason || (!!props.running && !queues);

  const addFiles = async (files: Iterable<File>) => {
    setError(undefined);
    for (const file of files) {
      if (!TYPES.includes(file.type as ImageAttachment["mediaType"])) {
        setError("Only PNG, JPEG, WebP and GIF images can be attached.");
        continue;
      }
      if (file.size > MAX_BYTES) {
        setError(`${file.name} is larger than 10 MB.`);
        continue;
      }
      const url = await readAsDataUrl(file);
      const data = url.slice(url.indexOf(",") + 1);
      setImages((list) => [...list, { mediaType: file.type as ImageAttachment["mediaType"], data, name: file.name, url }]);
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (blocked || sending || !text.trim()) return;
    setError(undefined);
    if (queues) {
      props.onQueue!({ text, images: images.map(({ url: _u, ...img }) => img), computerUse: computer, allowFailingChecks: allowFailing });
      setText("");
      setImages([]);
      return;
    }
    setSending(true);
    try {
      await props.onSubmit({
        text,
        images: images.map(({ url: _u, ...img }) => img),
        computerUse: computer,
        allowFailingChecks: allowFailing,
      });
      setText("");
      setImages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className={`composer${dragging ? " dragging" : ""}`}
      aria-label="Message composer"
      onSubmit={submit}
      onDragOver={(e: DragEvent) => {
        if ([...e.dataTransfer.items].some((i) => i.kind === "file")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {props.queued && props.queued.length > 0 && (
        <section className="queue" aria-label="Queued messages">
          <p className="queue-head">
            <span>
              {props.queuePaused
                ? props.queueError
                  ? `Not sent: ${props.queueError}`
                  : "Waiting: the task was stopped."
                : props.queued.length === 1
                  ? "Sent when the current task finishes."
                  : `Sent one after another when the current task finishes.`}
            </span>
            {props.queuePaused && props.onResumeQueue && (
              <button type="button" className="link-btn" onClick={props.onResumeQueue}>
                Send next now
              </button>
            )}
          </p>
          <ol>
            {props.queued.map((m, i) => (
              <li key={m.id}>
                <span className="queue-text">{m.input.text}</span>
                {m.input.images.length > 0 && <span className="meta">{m.input.images.length === 1 ? "1 image" : `${m.input.images.length} images`}</span>}
                <button
                  type="button"
                  className="link-btn"
                  aria-label={`Edit queued message ${i + 1}`}
                  onClick={() => {
                    props.onUnqueue?.(m.id);
                    setText(m.input.text);
                    setImages(m.input.images.map((img) => ({ ...img, url: `data:${img.mediaType};base64,${img.data}` })));
                    setComputer(m.input.computerUse);
                    setAllowFailing(m.input.allowFailingChecks);
                    area.current?.focus();
                  }}
                >
                  Edit
                </button>
                <button type="button" className="remove" aria-label={`Remove queued message ${i + 1}`} onClick={() => props.onUnqueue?.(m.id)}>
                  <XIcon size={11} />
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {images.length > 0 && (
        <ul className="attachments" aria-label="Attached images">
          {images.map((img, i) => (
            <li key={`${img.name}-${i}`}>
              <img src={img.url} alt={img.name ?? `image ${i + 1}`} />
              <button type="button" className="remove" aria-label={`Remove ${img.name ?? `image ${i + 1}`}`} onClick={() => setImages((l) => l.filter((_, j) => j !== i))}>
                <XIcon size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <label htmlFor="composer-text" className="visually-hidden">
        Message
      </label>
      <textarea
        id="composer-text"
        ref={area}
        rows={2}
        value={text}
        disabled={!!props.disabledReason}
        placeholder={props.disabledReason ?? (queues ? "Write the next message; it is sent when the current task finishes…" : (props.placeholder ?? "Ask Local Kovach to do something…"))}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e: ClipboardEvent) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="composer-bar">
        <div className="composer-tools">
          <input
            ref={fileInput}
            type="file"
            accept={TYPES.join(",")}
            multiple
            hidden
            aria-label="Attach images"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button type="button" className="icon-btn" title="Attach images" aria-label="Attach images" onClick={() => fileInput.current?.click()}>
            <PaperclipIcon />
          </button>
          {props.computerUse && (
            <button
              type="button"
              className={`toggle${computer ? " on" : ""}`}
              aria-pressed={computer}
              title="Let this task see and control the screen (you approve each action)"
              onClick={() => setComputer((c) => !c)}
            >
              <MonitorIcon size={14} /> Computer
            </button>
          )}
          {props.mode === "new" && (
            <ProjectPicker
              projects={props.projects ?? []}
              value={props.projectId}
              onChange={(id) => props.onProjectChange?.(id)}
              {...(props.onAddProject ? { onAdd: props.onAddProject } : {})}
            />
          )}
          <label className="check-option">
            <input type="checkbox" checked={allowFailing} onChange={(e) => setAllowFailing(e.target.checked)} />
            Let it finish even if checks fail
          </label>
        </div>
        {props.running ? (
          <div className="send-group">
            {queues && text.trim() && (
              <button type="submit" className="send" aria-label="Queue message" title="Send when the current task finishes">
                <ArrowUpIcon />
              </button>
            )}
            <button type="button" className="send stop" aria-label="Stop" onClick={props.onStop}>
              <StopIcon />
            </button>
          </div>
        ) : queues ? (
          <button type="submit" className="send" aria-label="Queue message" title="Send when the current task finishes" disabled={!!props.disabledReason || !text.trim()}>
            <ArrowUpIcon />
          </button>
        ) : (
          <button type="submit" className="send" aria-label="Send" disabled={blocked || sending || !text.trim()}>
            <ArrowUpIcon />
          </button>
        )}
      </div>
    </form>
  );
}

const ADD = "__add__";
const NONE = "__none__";

function ProjectPicker(props: {
  projects: ProjectInfo[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  onAdd?: () => Promise<ProjectInfo | undefined>;
}) {
  return (
    <label className="project-picker">
      <span className="visually-hidden">Project</span>
      <select
        aria-label="Project"
        value={props.value ?? NONE}
        onChange={async (e) => {
          const v = e.target.value;
          if (v === ADD) {
            const p = await props.onAdd?.();
            if (p) props.onChange(p.id);
          } else props.onChange(v === NONE ? undefined : v);
        }}
      >
        <option value={NONE}>No project</option>
        {props.projects.map((p) => (
          <option key={p.id} value={p.id} title={p.path}>
            {p.name}
          </option>
        ))}
        {props.onAdd && <option value={ADD}>Add project folder…</option>}
      </select>
    </label>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("Couldn't read the image"));
    r.readAsDataURL(file);
  });
}
