/**
 * Strict search/replace edits (MASTER_PLAN.md › Agent quality, item 4).
 * Every `old` block must appear exactly once in the file as it stands after
 * the previous blocks; otherwise nothing is written and the model gets an
 * error it can act on.
 */

export interface EditBlock {
  old: string;
  new: string;
}

/**
 * `changedLines`: existing lines replaced or rewritten (the per-step limit for changes).
 * `addedLines`: new lines inserted next to an unchanged anchor ("old" kept whole at the
 * start or end of "new"). Those touch nothing that was there, like a new file does, so
 * they count against the new-content limit instead.
 */
export type EditResult = { ok: true; content: string; changedLines: number; addedLines: number } | { ok: false; error: string };

const lineCount = (s: string) => (s === "" ? 0 : s.split("\n").length);

/** True when the block only inserts text before or after its "old" anchor, leaving the anchor as it was. */
export function isInsertion(block: EditBlock): boolean {
  return block.new.length > block.old.length && (block.new.startsWith(block.old) || block.new.endsWith(block.old));
}

/** Lines touched by one replacement: the larger of the old and new block (0 for a pure insertion). */
export function changedLines(block: EditBlock): number {
  return isInsertion(block) ? 0 : Math.max(lineCount(block.old), lineCount(block.new));
}

/** Lines a pure insertion adds. */
export function addedLines(block: EditBlock): number {
  return isInsertion(block) ? Math.max(1, lineCount(block.new) - lineCount(block.old)) : 0;
}

/** 1-based line numbers where `needle` starts in `text`. */
function matchLines(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) out.push(text.slice(0, at).split("\n").length);
  return out;
}

export function applyEdits(content: string, blocks: EditBlock[]): EditResult {
  if (blocks.length === 0) return { ok: false, error: "no edits given" };
  let text = content;
  let changed = 0;
  let added = 0;
  for (const [i, block] of blocks.entries()) {
    const label = blocks.length > 1 ? `edit ${i + 1}: ` : "";
    if (block.old === "") return { ok: false, error: `${label}"old" is empty; to create a file use create_file` };
    if (block.old === block.new) return { ok: false, error: `${label}"old" and "new" are identical` };
    const first = text.indexOf(block.old);
    if (first < 0) {
      const hint = nearestLine(text, block.old);
      return {
        ok: false,
        error: `${label}"old" text not found. Copy it exactly from read_file output, including whitespace${hint ? `. Closest line in the file: ${JSON.stringify(hint)}` : ""}.`,
      };
    }
    if (text.indexOf(block.old, first + 1) >= 0) {
      const lines = matchLines(text, block.old);
      const shown = lines.slice(0, 6).join(", ") + (lines.length > 6 ? ", …" : "");
      return {
        ok: false,
        error: `${label}"old" text appears ${lines.length} times (starting on lines ${shown}); include more surrounding lines so it matches only the place you mean, or use insert_lines with a line number to add new lines`,
      };
    }
    text = text.slice(0, first) + block.new + text.slice(first + block.old.length);
    changed += changedLines(block);
    added += addedLines(block);
  }
  return { ok: true, content: text, changedLines: changed, addedLines: added };
}

/** The file line most similar to the first line of the missing block, to help the model fix whitespace. */
function nearestLine(text: string, block: string): string | undefined {
  const target = block.split("\n").find((l) => l.trim())?.trim();
  if (!target) return undefined;
  let best: { line: string; score: number } | undefined;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t === target) return line;
    const score = commonPrefix(t, target);
    if (score > 8 && (!best || score > best.score)) best = { line, score };
  }
  return best?.line;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
