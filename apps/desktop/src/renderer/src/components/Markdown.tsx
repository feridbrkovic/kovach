import { createContext, Fragment, type ReactNode, useContext, useEffect, useState } from "react";

/**
 * A small, safe Markdown renderer: React elements only, never raw HTML. Covers
 * what the agent writes — paragraphs, headings, lists, quotes, fenced code,
 * inline code, bold, italic, links and attachment images.
 */

/** Resolves `attachment:<name>` images to data: URLs (the agent API in the app). */
export const AttachmentContext = createContext<((name: string) => Promise<string>) | undefined>(undefined);

/**
 * Memory citations like [m:4f2a9c] are for bookkeeping; the "Used N memories" list
 * under the answer shows the sources. Leave markdown links ([m:x](url)) alone.
 */
const CITATION = /[ \t]?(?<![\w\])])\[(?:m|e|d):[\w.:-]{1,60}\](?!\()/g;
export const stripCitations = (text: string) =>
  // Code stays untouched: fenced blocks and `inline code` are split out first.
  text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(CITATION, "")))
    .join("");

export function Markdown({ text, citations = "hide" }: { text: string; citations?: "hide" | "show" }) {
  return <div className="md">{blocks(citations === "hide" ? stripCitations(text) : text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++; // closing fence
      out.push(<CodeBlock key={key++} lang={fence[2] ?? ""} code={body.join("\n")} />);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length + 2, 6); // h3..h6 inside a message
      const Tag = `h${level}` as "h3";
      out.push(<Tag key={key++}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key++}>{blocks(body.join("\n"))}</blockquote>);
      continue;
    }
    // A table: a row of cells, then the |---|---| rule. Models answer with these for lists of placeholders, options, files.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        <div key={key++} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>
                  {head.map((_, k) => (
                    <td key={k}>{inline(r[k] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        if (re.test(lines[i]!)) items.push(lines[i]!.replace(re, ""));
        else items[items.length - 1] += ` ${lines[i]!.trim()}`;
        i++;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key++}>
          {items.map((it, j) => {
            const task = /^\[([ xX])\]\s+(.*)$/.exec(it);
            return task ? (
              <li key={j} className="task">
                <input type="checkbox" checked={task[1] !== " "} readOnly aria-label={task[2]} /> {inline(task[2]!)}
              </li>
            ) : (
              <li key={j}>{inline(it)}</li>
            );
          })}
        </List>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]!)) para.push(lines[i++]!);
    if (!para.length) para.push(lines[i++]!);
    out.push(<p key={key++}>{inline(para.join("\n"))}</p>);
  }
  return out;
}

/** Inline markup: images, links, code, bold, italic; line breaks kept. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\n)/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1]) out.push(<MdImage key={k++} alt={m[2] ?? ""} src={m[3]!} />);
    else if (m[4]) {
      const href = m[6]!;
      out.push(
        /^https?:\/\//.test(href) ? (
          <a key={k++} href={href} target="_blank" rel="noreferrer noopener">
            {m[5]}
          </a>
        ) : (
          <Fragment key={k++}>{m[5]}</Fragment>
        ),
      );
    } else if (m[7]) out.push(<code key={k++}>{m[7].slice(1, -1)}</code>);
    else if (m[8]) out.push(<strong key={k++}>{m[8].slice(2, -2)}</strong>);
    else if (m[9]) out.push(<em key={k++}>{m[9].slice(1, -1)}</em>);
    else if (m[10]) out.push(<br key={k++} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return out;
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{lang || "text"}</span>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** An image from an attachment (pasted, a screenshot, a generated picture); other URLs aren't loaded. */
export function MdImage({ alt, src }: { alt: string; src: string }) {
  const read = useContext(AttachmentContext);
  const [url, setUrl] = useState<string | undefined>(src.startsWith("data:image/") ? src : undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const name = /^attachment:(.+)$/.exec(src)?.[1];
    if (!name || !read) return;
    let cancelled = false;
    read(name).then(
      (u) => !cancelled && setUrl(u),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [src, read]);
  if (failed || (!url && !src.startsWith("attachment:"))) return <span className="meta">[{alt || "image"}]</span>;
  if (!url) return <span className="img-placeholder" aria-busy="true" />;
  return (
    <a className="md-img" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.preventDefault()}>
      <img src={url} alt={alt} />
    </a>
  );
}
