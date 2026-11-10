import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the LLM boundary so the judge pass is deterministic (no API key, CI-safe).
vi.mock("../src/llm/claude.js", () => ({ generateStructured: vi.fn() }));

import { generateStructured } from "../src/llm/claude.js";
import {
  GroundednessScore,
  INSUFFICIENT_EVIDENCE,
  guardAnswer,
  scoreGroundedness,
} from "../src/guards/groundedness.js";
import type { Answer } from "../src/schema.js";

const mockGen = vi.mocked(generateStructured);
const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 };
// Shape a StructResult<GroundednessScore> the way the Anthropic SDK wrapper returns it.
const judged = (groundedness: number) =>
  ({ data: { groundedness }, usage, stopReason: "end_turn", model: "claude-haiku-5-5", refused: false }) as never;

const THRESHOLD = 0.5;
const CONTEXT = "[chunk 1 | T1566] T1566 — Phishing. Adversaries send phishing messages to gain access.";
const baseAnswer: Answer = {
  text: "T1566 (Phishing) covers adversaries sending phishing messages to gain access.",
  citations: [{ chunkId: 1, extId: "T1566" }],
  strategy: "rag",
  groundedness: null,
};

afterEach(() => vi.clearAllMocks());

describe("GroundednessScore — Zod validation of the judge output", () => {
  it("accepts a score in [0,1]", () => {
    expect(GroundednessScore.parse({ groundedness: 0.9 }).groundedness).toBe(0.9);
  });
  it("rejects out-of-range or wrong-typed scores", () => {
    expect(GroundednessScore.safeParse({ groundedness: 1.5 }).success).toBe(false);
    expect(GroundednessScore.safeParse({ groundedness: -0.1 }).success).toBe(false);
    expect(GroundednessScore.safeParse({ groundedness: "high" }).success).toBe(false);
  });
});

describe("scoreGroundedness — separate judge pass (mocked LLM)", () => {
  it("returns the parsed score + model from the judge", async () => {
    mockGen.mockResolvedValueOnce(judged(0.9));
    expect(await scoreGroundedness("q", "answer", CONTEXT)).toEqual({
      score: 0.9,
      model: "claude-haiku-5-5",
      usage,
    });
  });
  it("returns null when the judge produced no structured data", async () => {
    mockGen.mockResolvedValueOnce({ data: null, usage, stopReason: "refusal", model: "x", refused: true } as never);
    expect(await scoreGroundedness("q", "a", CONTEXT)).toBeNull();
  });
});

describe("groundedness guard — two fixtures", () => {
  it("FIXTURE 1: answer fully supported by context (judge 0.9) → PASSES through", async () => {
    mockGen.mockResolvedValueOnce(judged(0.9));
    const g = await scoreGroundedness("q", baseAnswer.text, CONTEXT);
    const out = guardAnswer(baseAnswer, g?.score ?? null, THRESHOLD);
    expect(out.text).toBe(baseAnswer.text); // generator answer preserved
    expect(out.groundedness).toBe(0.9);
  });

  it("FIXTURE 2: answer asserts a fact absent from context (judge 0.1) → GUARD OVERRIDES", async () => {
    mockGen.mockResolvedValueOnce(judged(0.1));
    // Fabricated claim: CVSS score + OpenSSL patch not present in the phishing context.
    const unsupported: Answer = { ...baseAnswer, text: "T1566 has a CVSS of 9.8 and was patched in OpenSSL 3.0." };
    const g = await scoreGroundedness("q", unsupported.text, CONTEXT);
    const out = guardAnswer(unsupported, g?.score ?? null, THRESHOLD);
    expect(out.text).toBe(INSUFFICIENT_EVIDENCE); // overridden regardless of generator output
    expect(out.groundedness).toBe(0.1);
    expect(out.citations).toEqual(unsupported.citations); // citations retained
  });

  it("passes through at exactly the threshold and when the score is null", () => {
    const atThreshold = guardAnswer(baseAnswer, 0.5, 0.5);
    expect(atThreshold.text).toBe(baseAnswer.text);
    expect(atThreshold.groundedness).toBe(0.5);
    const nullScore = guardAnswer(baseAnswer, null, 0.5);
    expect(nullScore.text).toBe(baseAnswer.text);
    expect(nullScore.groundedness).toBeNull();
  });
});
