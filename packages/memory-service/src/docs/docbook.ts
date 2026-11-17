/**
 * The PHP manual is DocBook XML (php/doc-en), not Markdown. This turns one page
 * into Markdown the chunker already understands: headings from section titles,
 * PHP signatures from method synopses, code blocks from program listings.
 * It is deliberately small: enough structure for search and for the agent to
 * read, not a full DocBook renderer.
 */

/** Entity definitions from doc-en's language-snippets.ent and entities/*.ent. */
export function parseEntities(text: string, into: Map<string, string> = new Map()): Map<string, string> {
  for (const m of text.matchAll(/<!ENTITY\s+([\w.\-]+)\s+(['"])([\s\S]*?)\2\s*>/g)) into.set(m[1]!, m[3]!);
  for (const m of text.matchAll(/<entity\s+name="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/entity>)/g)) into.set(m[1]!, m[2] ?? "");
  return into;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rarr: "→", copy: "©" };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });

type Tok = { k: "open" | "close" | "self"; name: string; attrs: string } | { k: "text"; text: string } | { k: "raw"; text: string };

/** Section-like elements: a <title> directly inside one is a heading. */
const SECTIONS = new Set(["book", "part", "chapter", "preface", "appendix", "article", "reference", "refentry", "refsect1", "refsect2", "refsect3", "refsection", "sect1", "sect2", "sect3", "sect4", "sect5", "section", "simplesect", "legalnotice", "phpdoc:classref", "phpdoc:exceptionref", "phpdoc:varentry"]);
const BLOCKS = new Set(["para", "simpara", "formalpara", "informalexample", "blockquote", "procedure", "step", "tip", "note", "warning", "caution", "important"]);
const ADMONITIONS: Record<string, string> = { note: "Note", warning: "Warning", caution: "Caution", tip: "Tip", important: "Important" };
const CODE = new Set(["programlisting", "screen", "synopsis", "literallayout"]);
const INLINE_CODE = new Set(["literal", "constant", "type", "classname", "interfacename", "enumname", "exceptionname", "varname", "filename", "command", "option", "code", "property", "replaceable", "methodname", "systemitem", "envar", "computeroutput", "userinput", "tag", "markup", "uri"]);
const SKIP = new Set(["info", "titleabbrev", "indexterm", "xi:include", "remark", "phpdoc:print"]);
const SYNOPSES = new Set(["methodsynopsis", "constructorsynopsis", "destructorsynopsis", "funcsynopsis"]);

function tokenize(xml: string, raw: string[]): Tok[] {
  const out: Tok[] = [];
  const re = /<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  const pushText = (s: string) => {
    if (!s) return;
    // CDATA sections were set aside as \u0000n\u0000 so entities in code stay untouched.
    const parts = s.split(/\u0000(\d+)\u0000/);
    parts.forEach((p, i) => {
      if (i % 2) out.push({ k: "raw", text: raw[Number(p)] ?? "" });
      else if (p) out.push({ k: "text", text: p });
    });
  };
  for (const m of xml.matchAll(re)) {
    pushText(xml.slice(last, m.index));
    last = m.index! + m[0].length;
    out.push({ k: m[1] ? "close" : m[4] ? "self" : "open", name: m[2]!.toLowerCase(), attrs: m[3] ?? "" });
  }
  pushText(xml.slice(last));
  return out;
}

const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, "\\$&")}\\s*=\\s*["']([^"']*)["']`).exec(attrs)?.[1];

/** Text of a token range with all tags dropped. */
const plain = (toks: Tok[]) =>
  decode(
    toks
      .map((t) => (t.k === "text" || t.k === "raw" ? t.text : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim(),
  );

/** The tokens between an open tag at `i` and its matching close; returns the index after the close. */
function inner(toks: Tok[], i: number): { body: Tok[]; end: number } {
  const open = toks[i] as Extract<Tok, { name: string }>;
  if (open.k === "self") return { body: [], end: i + 1 };
  let depth = 0;
  for (let j = i + 1; j < toks.length; j++) {
    const t = toks[j]!;
    if (t.k === "open" && t.name === open.name) depth++;
    else if (t.k === "close" && t.name === open.name) {
      if (depth === 0) return { body: toks.slice(i + 1, j), end: j + 1 };
      depth--;
    }
  }
  return { body: toks.slice(i + 1), end: toks.length };
}

/** A type, union and intersection types included: <type class="union"><type>int</type><type>null</type></type>. */
function typeText(body: Tok[], attrs = ""): string {
  const cls = attr(attrs, "class");
  if (cls === "union" || cls === "intersection") {
    const parts: string[] = [];
    for (let i = 0; i < body.length; ) {
      const t = body[i]!;
      if (t.k === "open" && t.name === "type") {
        const { body: b, end } = inner(body, i);
        parts.push(typeText(b, t.attrs));
        i = end;
      } else i++;
    }
    const joined = parts.join(cls === "union" ? "|" : "&");
    return cls === "intersection" ? `(${joined})` : joined;
  }
  return plain(body);
}

/** One PHP signature from a method/function synopsis. */
function signature(body: Tok[], kind: string): string {
  const mods: string[] = [];
  let ret = "";
  let name = kind === "constructorsynopsis" ? "__construct" : kind === "destructorsynopsis" ? "__destruct" : "";
  const params: string[] = [];
  for (let i = 0; i < body.length; ) {
    const t = body[i]!;
    if (t.k !== "open" && t.k !== "self") {
      i++;
      continue;
    }
    const { body: b, end } = inner(body, i);
    if (t.name === "modifier") mods.push(plain(b));
    else if (t.name === "type") ret = typeText(b, t.attrs);
    else if (t.name === "methodname" || t.name === "function") name = plain(b);
    else if (t.name === "methodparam" || t.name === "paramdef") {
      let type = "";
      let pname = "";
      let init = "";
      let ref = false;
      for (let j = 0; j < b.length; ) {
        const u = b[j]!;
        if (u.k !== "open") {
          j++;
          continue;
        }
        const r = inner(b, j);
        if (u.name === "type") type = typeText(r.body, u.attrs);
        else if (u.name === "parameter") {
          pname = plain(r.body);
          ref = attr(u.attrs, "role") === "reference";
        } else if (u.name === "initializer") init = plain(r.body);
        j = r.end;
      }
      const variadic = attr(t.attrs, "rep") === "repeat" ? "..." : "";
      params.push(`${type ? `${type} ` : ""}${ref ? "&" : ""}${variadic}$${pname}${init ? ` = ${init}` : ""}`);
    } else if (t.name === "void") params.length = 0;
    i = end;
  }
  const head = [...mods, "function"].join(" ");
  return `${kind === "funcsynopsis" ? "" : mods.length ? `${head} ` : ""}${name}(${params.join(", ")})${ret ? `: ${ret}` : ""}`;
}

/** A class synopsis as a short PHP outline: the class line, its properties and its methods. */
function classOutline(body: Tok[]): string {
  const lines: string[] = [];
  const head = { name: "", kind: "class", extends: [] as string[], implements: [] as string[] };
  for (let i = 0; i < body.length; ) {
    const t = body[i]!;
    if (t.k !== "open") {
      i++;
      continue;
    }
    const { body: b, end } = inner(body, i);
    if (t.name === "ooclass" || t.name === "oointerface" || t.name === "ooexception" || t.name === "ooenum") {
      // <ooclass><classname>X</classname></ooclass>, <ooclass><modifier>extends</modifier>…, <oointerface><modifier>implements</modifier>…
      const mi = b.findIndex((u) => u.k === "open" && u.name === "modifier");
      const mod = mi >= 0 ? plain(inner(b, mi).body) : "";
      const name = plain(mi >= 0 ? [...b.slice(0, mi), ...b.slice(inner(b, mi).end)] : b);
      if (mod === "extends") head.extends.push(name);
      else if (mod === "implements" || (t.name === "oointerface" && head.name)) head.implements.push(name);
      else if (!head.name) {
        head.name = `${mod ? `${mod} ` : ""}${name}`;
        if (t.name === "oointerface") head.kind = "interface";
        if (t.name === "ooenum") head.kind = "enum";
      }
    } else if (t.name === "classsynopsisinfo") {
      const text = plain(b);
      if (text) lines.push(`    // ${text}`);
    } else if (t.name === "fieldsynopsis") {
      const parts = { mods: [] as string[], type: "", name: "", init: "" };
      for (let j = 0; j < b.length; ) {
        const u = b[j]!;
        if (u.k !== "open") {
          j++;
          continue;
        }
        const r = inner(b, j);
        if (u.name === "modifier") parts.mods.push(plain(r.body));
        else if (u.name === "type") parts.type = typeText(r.body, u.attrs);
        else if (u.name === "varname") parts.name = plain(r.body);
        else if (u.name === "initializer") parts.init = plain(r.body);
        j = r.end;
      }
      const isConst = parts.mods.includes("const");
      const name = parts.name.replace(/^\$/, "");
      lines.push(`    ${[...parts.mods, parts.type].filter(Boolean).join(" ")} ${isConst ? name.replace(/^.*::/, "") : `$${name}`}${parts.init ? ` = ${parts.init}` : ""};`);
    } else if (SYNOPSES.has(t.name)) lines.push(`    ${signature(b, t.name)};`);
    i = end;
  }
  if (head.name) {
    const h = `${head.kind} ${head.name}${head.extends.length ? ` extends ${head.extends.join(", ")}` : ""}${head.implements.length ? ` implements ${head.implements.join(", ")}` : ""} {`;
    lines.unshift(h);
    lines.push("}");
  }
  return lines.length ? `\n\n\`\`\`php\n${lines.join("\n")}\n\`\`\`\n\n` : "";
}

export interface DocbookPage {
  markdown: string;
  /** The page's xml:id, e.g. "function.array-map" (php.net/manual/en/<id>.php). */
  id?: string;
}

/** Convert one DocBook page to Markdown. `entities` come from parseEntities. */
export function docbookToMarkdown(xml: string, entities: Map<string, string> = new Map()): DocbookPage {
  const raw: string[] = [];
  let src = xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => `\u0000${raw.push(c) - 1}\u0000`)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  // Entities can hold markup and other entities; expand a few levels, then drop the unknown ones.
  for (let pass = 0; pass < 6 && /&[\w.\-]+;/.test(src); pass++) {
    src = src.replace(/&([\w.\-]+);/g, (m, name: string) => (XML_ENTITIES[name.toLowerCase()] || name.startsWith("#") ? m : (entities.get(name) ?? m)));
  }
  src = src.replace(/&([\w.\-]+);/g, (m, name: string) => (XML_ENTITIES[name.toLowerCase()] || name.startsWith("#") ? m : ""));

  const toks = tokenize(src, raw);
  const rootTag = toks.find((t): t is Extract<Tok, { name: string }> => t.k === "open");
  const id = rootTag ? attr(rootTag.attrs, "xml:id") : undefined;

  let out = "";
  let depth = 0;
  const emit = (s: string) => {
    out += s;
  };
  const walk = (list: Tok[]) => {
    for (let i = 0; i < list.length; ) {
      const t = list[i]!;
      if (t.k === "text") {
        emit(decode(t.text.replace(/\s+/g, " ")));
        i++;
        continue;
      }
      if (t.k === "raw") {
        emit(t.text);
        i++;
        continue;
      }
      if (t.k === "close") {
        i++;
        continue;
      }
      const { body, end } = inner(list, i);
      const n = t.name;
      if (SKIP.has(n)) {
        // nothing
      } else if (n === "refnamediv") {
        const names: string[] = [];
        let purpose = "";
        for (let j = 0; j < body.length; ) {
          const u = body[j]!;
          if (u.k !== "open") {
            j++;
            continue;
          }
          const r = inner(body, j);
          if (u.name === "refname") names.push(plain(r.body));
          else if (u.name === "refpurpose") purpose = plain(r.body);
          j = r.end;
        }
        emit(`\n\n# ${names.join(", ")}\n\n${purpose}\n\n`);
      } else if (SECTIONS.has(n)) {
        depth++;
        walk(body);
        depth--;
        emit("\n\n");
      } else if (n === "title") {
        const text = plain(body);
        if (text) emit(`\n\n${"#".repeat(Math.min(Math.max(depth, 1), 6))} ${text}\n\n`);
      } else if (n === "example") {
        const ti = body.findIndex((u) => u.k === "open" && u.name === "title");
        if (ti >= 0) {
          const r = inner(body, ti);
          emit(`\n\n**Example: ${plain(r.body)}**\n\n`);
          walk([...body.slice(0, ti), ...body.slice(r.end)]);
        } else walk(body);
        emit("\n\n");
      } else if (CODE.has(n)) {
        const code = body
          .map((u) => (u.k === "raw" ? u.text : u.k === "text" ? decode(u.text) : ""))
          .join("")
          .replace(/^\n+|\s+$/g, "");
        const lang = attr(t.attrs, "role") ?? (n === "screen" ? "text" : "");
        if (code) emit(`\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`);
      } else if (SYNOPSES.has(n)) {
        emit(`\n\n\`\`\`php\n${signature(body, n)}\n\`\`\`\n\n`);
      } else if (n === "classsynopsis" || n === "enumsynopsis" || n === "packagesynopsis") {
        emit(classOutline(body));
      } else if (n === "fieldsynopsis") {
        emit(classOutline([t, ...body, { k: "close", name: n, attrs: "" }]));
      } else if (BLOCKS.has(n)) {
        emit("\n\n");
        if (ADMONITIONS[n]) emit(`**${ADMONITIONS[n]}:** `);
        walk(body);
        emit("\n\n");
      } else if (n === "varlistentry") {
        const ti = body.findIndex((u) => u.k === "open" && u.name === "term");
        const rest = ti >= 0 ? [...body.slice(0, ti), ...body.slice(inner(body, ti).end)] : body;
        if (ti >= 0) emit(`\n\n**${plain(inner(body, ti).body)}**\n\n`);
        // The definition is the entry's own listitem: its content, not a bullet.
        for (let j = 0; j < rest.length; ) {
          const u = rest[j]!;
          if (u.k === "open" && u.name === "listitem") {
            const r = inner(rest, j);
            walk(r.body);
            j = r.end;
          } else {
            walk([u]);
            j++;
          }
        }
      } else if (n === "listitem" || n === "member") {
        // The item's text goes on the bullet line, and items follow each other without a gap.
        const saved = out;
        out = "";
        walk(body);
        out = `${saved}\n- ${out.trim()}`;
      } else if (n === "row") {
        const cells: string[] = [];
        for (let j = 0; j < body.length; ) {
          const u = body[j]!;
          if (u.k === "open" && u.name === "entry") {
            const r = inner(body, j);
            cells.push(plain(r.body).replace(/\|/g, "\\|"));
            j = r.end;
          } else j++;
        }
        emit(`\n| ${cells.join(" | ")} |`);
      } else if (n === "function") {
        const text = plain(body);
        emit(`\`${text.endsWith(")") ? text : `${text}()`}\``);
      } else if (n === "parameter") {
        emit(`\`$${plain(body).replace(/^\$/, "")}\``);
      } else if (INLINE_CODE.has(n)) {
        const text = plain(body);
        if (text) emit(`\`${text}\``);
      } else if (n === "emphasis" || n === "firstterm" || n === "citetitle") {
        emit(`*${plain(body)}*`);
      } else if (n === "xref") {
        // a cross-reference with no text of its own
      } else {
        // Containers and inline wrappers (link, tgroup, variablelist…): keep their content.
        walk(body);
      }
      i = end;
    }
  };
  walk(toks);
  const markdown = out
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/ {2,}/g, " ")))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    // "**Note:**" and its first paragraph on one line.
    .replace(/(\*\*(?:Note|Warning|Caution|Tip|Important):\*\*) *\n\n/g, "$1 ")
    .trim();
  return { markdown, ...(id ? { id } : {}) };
}
