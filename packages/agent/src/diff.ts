/**
 * Unified line diffs of what a run changed, for the self-review. A classic
 * longest-common-subsequence diff: plenty for files an agent edits in one task.
 */

/** Above this many line pairs the LCS table gets too big; such files are shown as replaced. */
const MAX_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; text: string };

function lineOps(a: string[], b: string[]): Op[] | undefined {
  // Shared head and tail first: most edits touch a small middle part.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) return undefined;
  // lcs[i][j]: LCS length of midA[i..] and midB[j..], in one flat array.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const ops: Op[] = a.slice(0, start).map((text) => ({ kind: " ", text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ kind: " ", text: midA[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) ops.push({ kind: "-", text: midA[i++]! });
    else ops.push({ kind: "+", text: midB[j++]! });
  }
  while (i < n) ops.push({ kind: "-", text: midA[i++]! });
  while (j < m) ops.push({ kind: "+", text: midB[j++]! });
  for (const text of a.slice(endA)) ops.push({ kind: " ", text });
  return ops;
}

const splitLines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/**
 * A unified diff of one file ("" when nothing changed). `before` null means the
 * file is new; `after` null means it was deleted.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  if (before === after) return "";
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  const head = `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ ${after === null ? "/dev/null" : `b/${path}`}\n`;
  const ops = lineOps(a, b) ?? [...a.map((text) => ({ kind: "-" as const, text })), ...b.map((text) => ({ kind: "+" as const, text }))];
  // Group changes with `context` unchanged lines around them into hunks.
  const hunks: string[] = [];
  let k = 0;
  let lineA = 1;
  let lineB = 1;
  const pos: { a: number; b: number }[] = [];
  for (const op of ops) {
    pos.push({ a: lineA, b: lineB });
    if (op.kind !== "+") lineA++;
    if (op.kind !== "-") lineB++;
  }
  while (k < ops.length) {
    if (ops[k]!.kind === " ") {
      k++;
      continue;
    }
    let from = Math.max(0, k - context);
    let to = k;
    // Extend while the next change is within 2×context unchanged lines.
    for (;;) {
      while (to < ops.length && ops[to]!.kind !== " ") to++;
      let gap = to;
      while (gap < ops.length && ops[gap]!.kind === " " && gap - to < context * 2) gap++;
      if (gap < ops.length && ops[gap]!.kind !== " ") to = gap;
      else break;
    }
    const end = Math.min(ops.length, to + context);
    const slice = ops.slice(from, end);
    const countA = slice.filter((o) => o.kind !== "+").length;
    const countB = slice.filter((o) => o.kind !== "-").length;
    const startA = countA ? pos[from]!.a : pos[from]!.a - 1;
    const startB = countB ? pos[from]!.b : pos[from]!.b - 1;
    hunks.push(`@@ -${startA},${countA} +${startB},${countB} @@\n${slice.map((o) => `${o.kind}${o.text}`).join("\n")}`);
    k = end;
    from = end;
  }
  return hunks.length ? `${head}${hunks.join("\n")}\n` : "";
}
