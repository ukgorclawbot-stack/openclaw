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

  it("applies oversized tool-result truncation before preflight compaction estimates", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-tool-result-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const oversizedToolResult = `tool output ${"x".repeat(360_000)}`;

    try {
      await fs.writeFile(
        sessionFile,
        [
          JSON.stringify({
            id: "entry-1",
            message: {
              role: "user",
              content: "older ask",
              timestamp: 1,
            },
          }),
          JSON.stringify({
            id: "entry-2",
            message: {
              role: "assistant",
              content: "tool reply",
              timestamp: 2,
            },
          }),
          JSON.stringify({
            id: "entry-3",
            message: {
              role: "toolResult",
              content: [{ type: "text", text: oversizedToolResult }],
              timestamp: 3,
            },
          }),
          JSON.stringify({
            id: "entry-4",
            message: {
              role: "user",
              content: "latest ask",
              timestamp: 4,
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const fullEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-tool-result-test",
        sessionFile,
      });
      expect(fullEstimate).toBeGreaterThan(0);

      const truncatedEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-tool-result-test",
        sessionFile,
        contextWindowTokens: 100_000,
      });

      expect(truncatedEstimate).toBeGreaterThan(0);
      expect(truncatedEstimate).toBeLessThan(fullEstimate ?? Number.POSITIVE_INFINITY);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated thread starter context before preflight compaction estimates", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-thread-starter-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const repeatedThreadStarter = `starter ${"x".repeat(4_000)}`;

    try {
      await fs.writeFile(
        sessionFile,
        [
          JSON.stringify({
            id: "entry-1",
            message: {
              role: "user",
              content: "older ask 1",
              contextSidecar: {
                formatVersion: 1,
                thread: {
                  starterBody: repeatedThreadStarter,
                },
                conversation: {
                  hasThreadStarter: true,
                },
              },
              timestamp: 1,
            },
          }),
          JSON.stringify({
            id: "entry-2",
            message: {
              role: "assistant",
              content: "older answer 1",
              timestamp: 2,
            },
          }),
          JSON.stringify({
            id: "entry-3",
            message: {
              role: "user",
              content: "older ask 2",
              contextSidecar: {
                formatVersion: 1,
                thread: {
                  starterBody: repeatedThreadStarter,
                },
                conversation: {
                  hasThreadStarter: true,
                },
              },
              timestamp: 3,
            },
          }),
          JSON.stringify({
            id: "entry-4",
            message: {
              role: "assistant",
              content: "older answer 2",
              timestamp: 4,
            },
          }),
          JSON.stringify({
            id: "entry-5",
            message: {
              role: "user",
              content: "latest ask",
              contextSidecar: {
                formatVersion: 1,
                thread: {
                  starterBody: repeatedThreadStarter,
                },
                conversation: {
                  hasThreadStarter: true,
                },
              },
              timestamp: 5,
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const fullEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-thread-starter-test",
        sessionFile,
      });
      expect(fullEstimate).toBeGreaterThan(0);

      const projectedEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-thread-starter-test",
        sessionFile,
        projectionTokenBudget: Math.max(1, (fullEstimate ?? 1) - 200),
      });

      expect(projectedEstimate).toBeGreaterThan(0);
      expect(projectedEstimate).toBeLessThan(fullEstimate ?? Number.POSITIVE_INFINITY);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("caps inbound-history payloads before preflight compaction estimates", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-history-cap-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const repeatedHistory = Array.from({ length: 4 }, (_, index) => ({
      sender: "Bob",
      timestampMs: index + 1,
      body: `older context ${index} ${"x".repeat(1_500)}`,
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
        sessionId: "session-history-cap-test",
        sessionFile,
      });
      expect(fullEstimate).toBeGreaterThan(0);

      const cappedEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-history-cap-test",
        sessionFile,
        projectionTokenBudget: Math.max(1, (fullEstimate ?? 1) - 400),
      });
      const fullyTrimmedEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-history-cap-test",
        sessionFile,
        projectionTokenBudget: 1,
      });

      expect(cappedEstimate).toBeGreaterThan(0);
      expect(cappedEstimate).toBeLessThan(fullEstimate ?? Number.POSITIVE_INFINITY);
      expect(cappedEstimate).toBeGreaterThan(fullyTrimmedEstimate ?? 0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("caps quoted reply bodies before preflight compaction estimates", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-reply-cap-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const repeatedReplyBody = `quoted ${"x".repeat(3_000)}`;

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
                reply: {
                  senderLabel: "Alice",
                  body: repeatedReplyBody,
                },
                conversation: {
                  hasReplyContext: true,
                },
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
                reply: {
                  senderLabel: "Alice",
                  body: repeatedReplyBody,
                },
                conversation: {
                  hasReplyContext: true,
                },
              },
              timestamp: 3,
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const fullEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-reply-cap-test",
        sessionFile,
      });
      expect(fullEstimate).toBeGreaterThan(0);

      const cappedEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-reply-cap-test",
        sessionFile,
        projectionTokenBudget: Math.max(1, (fullEstimate ?? 1) - 300),
      });

      expect(cappedEstimate).toBeGreaterThan(0);
      expect(cappedEstimate).toBeLessThan(fullEstimate ?? Number.POSITIVE_INFINITY);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps lightweight forwarded context before the more aggressive projection path", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-forwarded-cap-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    const repeatedSignature = `sig ${"x".repeat(2_500)}`;

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
                forwarded: {
                  from: "relay-bot",
                  type: "channel",
                  title: "Very Long Forward Title",
                  signature: repeatedSignature,
                },
                conversation: {
                  hasForwardedContext: true,
                },
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
                forwarded: {
                  from: "relay-bot",
                  type: "channel",
                  title: "Very Long Forward Title",
                  signature: repeatedSignature,
                },
                conversation: {
                  hasForwardedContext: true,
                },
              },
              timestamp: 3,
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const fullEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-forwarded-cap-test",
        sessionFile,
      });
      expect(fullEstimate).toBeGreaterThan(0);

      const cappedEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-forwarded-cap-test",
        sessionFile,
        projectionTokenBudget: Math.max(1, (fullEstimate ?? 1) - 200),
      });
      const fullyTrimmedEstimate = estimatePromptTokensFromSessionTranscript({
        sessionId: "session-forwarded-cap-test",
        sessionFile,
        projectionTokenBudget: 1,
      });

      expect(cappedEstimate).toBeGreaterThan(0);
      expect(cappedEstimate).toBeLessThan(fullEstimate ?? Number.POSITIVE_INFINITY);
      expect(cappedEstimate).toBeGreaterThan(fullyTrimmedEstimate ?? 0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
