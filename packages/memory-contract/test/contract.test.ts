import { describe, expect, it } from "vitest";
import { CandidateResolution, Memory, MemoryPatch, NewMemory, RetrievedItem, Trust } from "../src/index.js";

const base = {
  id: "m1",
  kind: "preference",
  scope: "global",
  key: "style.semicolons",
  body: "Prefer no semicolons in TypeScript.",
  trust: "user",
  status: "active",
  pinned: false,
  evidence: [{ type: "message", id: "msg1" }],
  useCount: 0,
  createdAt: 1,
  updatedAt: 1,
} as const;

describe("memory contract", () => {
  it("accepts a valid global memory", () => {
    expect(Memory.parse(base).key).toBe("style.semicolons");
  });

  it("requires projectId for project scope", () => {
    expect(Memory.safeParse({ ...base, scope: "project" }).success).toBe(false);
    expect(Memory.safeParse({ ...base, scope: "project", projectId: "p1" }).success).toBe(true);
  });

  it("forbids projectId on global scope", () => {
    expect(NewMemory.safeParse({ kind: "decision", scope: "global", projectId: "p1", key: "k", body: "b" }).success).toBe(
      false,
    );
  });

  it("orders trust levels as the plan defines", () => {
    expect(Trust.options).toEqual(["user", "verified", "official", "inferred"]);
  });

  it("rejects an empty patch", () => {
    expect(MemoryPatch.safeParse({}).success).toBe(false);
    expect(MemoryPatch.safeParse({ body: "new" }).success).toBe(true);
  });

  it("parses candidate resolutions", () => {
    expect(CandidateResolution.parse("accept")).toBe("accept");
    expect(CandidateResolution.safeParse({ edit: { body: "x" } }).success).toBe(true);
    expect(CandidateResolution.safeParse("maybe").success).toBe(false);
  });

  it("parses a retrieved item", () => {
    const item = RetrievedItem.parse({
      ref: { type: "episode", id: "e1" },
      text: "Metro cache must be cleared after upgrading react-native-reanimated.",
      score: 0.82,
      reasons: ["error_signature_match", "trust:verified"],
      possiblyOutdated: false,
      tokens: 18,
    });
    expect(item.ref.type).toBe("episode");
  });
});

describe("contract types", () => {
  it("lets callers omit defaulted fields when creating a memory", () => {
    const input: import("../src/index.js").NewMemoryInput = { kind: "preference", scope: "global", key: "k", body: "b" };
    expect(NewMemory.parse(input).pinned).toBe(false);
  });
});

describe("errors", () => {
  it("survives a transport that serializes errors to plain JSON", async () => {
    const { MemoryApiError, isMemoryApiError } = await import("../src/index.js");
    const wire = JSON.parse(JSON.stringify(new MemoryApiError("project_mode", "project p1 memory is off")));
    expect(wire).toEqual({ code: "project_mode", message: "project p1 memory is off" });
    const back = MemoryApiError.from(wire);
    expect(isMemoryApiError(back, "project_mode")).toBe(true);
    expect(back.message).toBe("project p1 memory is off");
  });

  it("maps unknown failures to unavailable", async () => {
    const { MemoryApiError } = await import("../src/index.js");
    expect(MemoryApiError.from(new Error("socket closed")).code).toBe("unavailable");
    expect(MemoryApiError.from({ code: "teapot", message: "x" }).code).toBe("unavailable");
  });
});

describe("version", () => {
  it("is a frozen semver release, not a draft", async () => {
    const { CONTRACT_VERSION } = await import("../src/index.js");
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
