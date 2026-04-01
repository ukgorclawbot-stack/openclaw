import { describe, expect, it } from "vitest";
import {
  buildCompactionContinuationMessage,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
} from "./compaction-contract.js";

describe("compaction-contract", () => {
  it("builds structured instructions with Claude-style continuation guidance", () => {
    const instructions = buildCompactionStructureInstructions("Keep security caveats.");

    expect(instructions).toContain("## Decisions");
    expect(instructions).toContain("## Open TODOs");
    expect(instructions).toContain("## Constraints/Rules");
    expect(instructions).toContain("## Pending user asks");
    expect(instructions).toContain("## Exact identifiers");
    expect(instructions).toContain("future run can continue the session directly");
    expect(instructions).toContain("Keep security caveats.");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("builds a structured fallback summary from legacy summary text", () => {
    const summary = buildStructuredFallbackSummary("legacy summary without headings");

    expect(summary).toContain("## Decisions");
    expect(summary).toContain("## Open TODOs");
    expect(summary).toContain("## Constraints/Rules");
    expect(summary).toContain("## Pending user asks");
    expect(summary).toContain("## Exact identifiers");
    expect(summary).toContain("legacy summary without headings");
  });

  it("formats a Claude-style continuation message for post-compaction resume", () => {
    const message = buildCompactionContinuationMessage({
      summary: "## Decisions\nKeep going.",
      transcriptPath: "/tmp/session.jsonl",
      recentMessagesPreserved: true,
      suppressFollowUpQuestions: true,
    });

    expect(message).toContain("continued from a previous conversation");
    expect(message).toContain("## Decisions\nKeep going.");
    expect(message).toContain("/tmp/session.jsonl");
    expect(message).toContain("Recent messages are preserved verbatim.");
    expect(message).toContain("do not acknowledge the summary");
    expect(message).toContain("Resume directly");
  });
});
