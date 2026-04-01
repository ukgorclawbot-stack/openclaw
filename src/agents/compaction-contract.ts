import type { CompactionSummarizationInstructions } from "./compaction.js";
import { wrapUntrustedPromptDataBlock } from "./sanitize-for-prompt.js";

const MAX_UNTRUSTED_INSTRUCTION_CHARS = 4000;
const MAX_CONTINUATION_FILES_PER_SECTION = 5;
const STRICT_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";
const POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, include identifiers only when needed for continuity; do not enforce literal-preservation rules.";
const CLAUDE_STYLE_CONTINUATION_INSTRUCTIONS = [
  "Write the summary so a future run can continue the session directly.",
  "Do not add greetings, acknowledgements, or recap prose outside the required sections.",
  "Emphasize the latest pending user ask and the current in-progress work so the next turn can resume immediately.",
].join("\n");

export const REQUIRED_COMPACTION_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;

function normalizeContinuationFileList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
}

function formatContinuationFileSection(label: string, files: string[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }

  const visibleFiles = files.slice(0, MAX_CONTINUATION_FILES_PER_SECTION);
  const omittedCount = files.length - visibleFiles.length;
  const suffix = omittedCount > 0 ? ` (+${omittedCount} more)` : "";
  return `- ${label}: ${visibleFiles.join(", ")}${suffix}`;
}

function formatCompactionWorkspaceDetails(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }

  const readFiles = normalizeContinuationFileList((details as { readFiles?: unknown }).readFiles);
  const modifiedFiles = normalizeContinuationFileList(
    (details as { modifiedFiles?: unknown }).modifiedFiles,
  );
  const lines = [
    formatContinuationFileSection("Read files", readFiles),
    formatContinuationFileSection("Modified files", modifiedFiles),
  ].filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return undefined;
  }

  return ["Recent workspace context before compaction:", ...lines].join("\n");
}

function wrapUntrustedInstructionBlock(label: string, text: string): string {
  return wrapUntrustedPromptDataBlock({
    label,
    text,
    maxChars: MAX_UNTRUSTED_INSTRUCTION_CHARS,
  });
}

function resolveExactIdentifierSectionInstruction(
  summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const policy = summarizationInstructions?.identifierPolicy ?? "strict";
  if (policy === "off") {
    return POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION;
  }
  if (policy === "custom") {
    const custom = summarizationInstructions?.identifierInstructions?.trim();
    if (custom) {
      const customBlock = wrapUntrustedInstructionBlock(
        "For ## Exact identifiers, apply this operator-defined policy text",
        custom,
      );
      if (customBlock) {
        return customBlock;
      }
    }
  }
  return STRICT_EXACT_IDENTIFIERS_INSTRUCTION;
}

export function buildCompactionStructureInstructions(
  customInstructions?: string,
  summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const identifierSectionInstruction =
    resolveExactIdentifierSectionInstruction(summarizationInstructions);
  const sectionsTemplate = [
    "Produce a compact, factual summary with these exact section headings:",
    ...REQUIRED_COMPACTION_SUMMARY_SECTIONS,
    identifierSectionInstruction,
    CLAUDE_STYLE_CONTINUATION_INSTRUCTIONS,
    "Do not omit unresolved asks from the user.",
  ].join("\n");
  const custom = customInstructions?.trim();
  if (!custom) {
    return sectionsTemplate;
  }
  const customBlock = wrapUntrustedInstructionBlock("Additional context from /compact", custom);
  if (!customBlock) {
    return sectionsTemplate;
  }
  return `${sectionsTemplate}\n\n${customBlock}`;
}

function normalizedSummaryLines(summary: string): string[] {
  return summary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasRequiredSummarySections(summary: string): boolean {
  const lines = normalizedSummaryLines(summary);
  let cursor = 0;
  for (const heading of REQUIRED_COMPACTION_SUMMARY_SECTIONS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line === heading);
    if (index < 0) {
      return false;
    }
    cursor = index + 1;
  }
  return true;
}

export function buildStructuredFallbackSummary(
  previousSummary: string | undefined,
  _summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  if (trimmedPreviousSummary && hasRequiredSummarySections(trimmedPreviousSummary)) {
    return trimmedPreviousSummary;
  }
  const exactIdentifiersSummary = "None captured.";
  return [
    "## Decisions",
    trimmedPreviousSummary || "No prior history.",
    "",
    "## Open TODOs",
    "None.",
    "",
    "## Constraints/Rules",
    "None.",
    "",
    "## Pending user asks",
    "None.",
    "",
    "## Exact identifiers",
    exactIdentifiersSummary,
  ].join("\n");
}

export function formatCompactionSummary(summary: string): string {
  let formattedSummary = summary;

  formattedSummary = formattedSummary.replace(/<analysis>[\s\S]*?<\/analysis>/u, "");

  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/u);
  if (summaryMatch) {
    const content = summaryMatch[1] || "";
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/u,
      `Summary:\n${content.trim()}`,
    );
  }

  formattedSummary = formattedSummary.replace(/\n\n+/gu, "\n\n");

  return formattedSummary.trim();
}

export function buildCompactionContinuationMessage(params: {
  summary: string;
  transcriptPath?: string;
  workspaceDetails?: unknown;
  recentMessagesPreserved?: boolean;
  suppressFollowUpQuestions?: boolean;
}): string {
  const formattedSummary = formatCompactionSummary(params.summary);
  let message =
    "This session is being continued from a previous conversation that ran out of context. " +
    "The summary below covers the earlier portion of the conversation.\n\n" +
    formattedSummary;

  if (params.transcriptPath) {
    message +=
      `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ` +
      params.transcriptPath;
  }

  const workspaceDetails = formatCompactionWorkspaceDetails(params.workspaceDetails);
  if (workspaceDetails) {
    message += `\n\n${workspaceDetails}`;
  }

  if (params.recentMessagesPreserved) {
    message += "\n\nRecent messages are preserved verbatim.";
  }

  if (params.suppressFollowUpQuestions) {
    message +=
      "\n\nContinue the conversation from where it left off without asking the user any further questions. " +
      "Resume directly, do not acknowledge the summary, do not recap what was happening, " +
      'do not preface with "I\'ll continue" or similar, and do not ask the user to repeat context unless it is truly missing. ' +
      "Pick up the last task as if the break never happened.";
  }

  return message;
}
