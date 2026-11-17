// @vitest-environment jsdom
import type { ToolCall } from "@kovach-dev/memory-contract";
import { describe, expect, it } from "vitest";
import { describeCall } from "../src/renderer/src/components/ToolCallView";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: "tc_1", name, args }) as ToolCall;
const brief = (c: ToolCall) => {
  const { verb, target, stat } = describeCall(c);
  return { verb, target, stat };
};

describe("tool calls in the transcript", () => {
  it("counts an insertion's new lines only, and a replacement's both sides", () => {
    const section = Array.from({ length: 300 }, (_, i) => `<p>${i}</p>`).join("\n");
    expect(brief(call("edit_file", { path: "index.html", edits: [{ old: "</main>", new: `${section}\n</main>` }] }))).toEqual({ verb: "Edit", target: "index.html", stat: "+300 −0" });
    expect(brief(call("edit_file", { path: "a.ts", edits: [{ old: "a\nb", new: "c" }] }))).toEqual({ verb: "Edit", target: "a.ts", stat: "+1 −2" });
  });

  it("shows an insertion with where it goes and how many lines", () => {
    expect(brief(call("insert_lines", { path: "index.html", afterLine: 313, content: "<section>\n</section>" }))).toEqual({ verb: "Insert", target: "index.html after line 313", stat: "+2" });
  });

  it("names the code navigation tools", () => {
    expect(brief(call("find_symbol", { name: "useCart" }))).toEqual({ verb: "Find", target: "useCart", stat: undefined });
    expect(brief(call("find_references", { name: "useCart" }))).toMatchObject({ verb: "Uses of", target: "useCart" });
    expect(brief(call("diagnostics", { paths: ["src/a.ts", "src/b.ts"] }))).toMatchObject({ verb: "Diagnostics", target: "src/a.ts, src/b.ts" });
    expect(brief(call("diagnostics", {}))).toMatchObject({ target: "recent changes" });
    expect(brief(call("self_review", { files: ["a.ts", "b.ts", "c.ts", "d.ts"] }))).toMatchObject({ verb: "Review", target: "a.ts, b.ts, c.ts +1" });
  });
});

describe("the review step", () => {
  it("says it found problems instead of showing an exit code", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { ToolCallView } = await import("../src/renderer/src/components/ToolCallView");
    render(<ToolCallView call={{ ...call("self_review", { files: ["src/cart.js"] }), exitCode: 1, output: "Must fix: src/cart.js:3: Empty carts return NaN." } as ToolCall} />);
    expect(screen.getByTitle("The review found problems to fix").textContent).toContain("found problems");
    expect(screen.queryByText(/exit 1/)).toBeNull();
  });
});
