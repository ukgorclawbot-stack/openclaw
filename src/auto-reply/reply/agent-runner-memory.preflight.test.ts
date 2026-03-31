import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { estimatePromptTokensFromSessionTranscript } from "./agent-runner-memory.js";

describe("estimatePromptTokensFromSessionTranscript", () => {
  it("applies sidecar projection budget before preflight compaction estimates", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-projection-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const repeatedHistory = Array.from({ length: 4 }, (_, index) => ({
      sender: "Bob",
      timestampMs: index + 1,
      body: `older context ${index} ${"x".repeat(800)}`,
    }));

    try {
      await fs.writeFile(
        sessionFile,
        [
          JSON.stringify({
            id: "entry-1",
            message: {
              role: "user",
              content: "older ask",
              contextSidecar: {
                formatVersion: 1,
                history: repeatedHistory,
                conversation: { historyCount: repeatedHistory.length },
              },
              timestamp: 1,
            },
          }),
          JSON.stringify({
            id: "entry-2",
            message: {
              role: "assistant",
              content: "older answer",
              timestamp: 2,
            },
          }),
          JSON.stringify({
            id: "entry-3",
            message: {
              role: "user",
              content: "latest ask",
              contextSidecar: {
                formatVersion: 1,
                history: repeatedHistory,
                conversation: { historyCount: repeatedHistory.length },
              },
              timestamp: 3,
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const fullEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-projection-test",
        sessionFile,
      });
      expect(fullEstimate).toBeGreaterThan(0);

      const trimmedEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-projection-test",
        sessionFile,
        projectionTokenBudget: Math.max(1, (fullEstimate ?? 1) - 200),
      });

      expect(trimmedEstimate).toBeGreaterThan(0);
      expect(trimmedEstimate).toBeLessThan(fullEstimate ?? Number.POSITIVE_INFINITY);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
