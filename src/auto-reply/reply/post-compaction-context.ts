import fs from "node:fs";
import path from "node:path";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { resolveUserTimezone } from "../../agents/date-time.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { OpenClawConfig } from "../../config/config.js";
import { openBoundaryFile } from "../../infra/boundary-file-read.js";

const MAX_CONTEXT_CHARS = 3000;
const MAX_FILE_EXCERPTS = 3;
const MAX_FILE_EXCERPT_CHARS = 600;
const MAX_FILE_EXCERPTS_TOTAL_CHARS = 1800;
const MAX_SKILL_EXCERPTS = 2;
const MAX_SKILL_EXCERPT_CHARS = 600;
const MAX_SKILL_EXCERPTS_TOTAL_CHARS = 1200;
const DEFAULT_POST_COMPACTION_SECTIONS = ["Session Startup", "Red Lines"];
const LEGACY_POST_COMPACTION_SECTIONS = ["Every Session", "Safety"];

function normalizeWorkspaceFileList(value: unknown): string[] {
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

function truncateFileExcerpt(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_FILE_EXCERPT_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_FILE_EXCERPT_CHARS)}\n...[truncated]...`;
}

function truncateSkillExcerpt(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_SKILL_EXCERPT_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SKILL_EXCERPT_CHARS)}\n...[truncated]...`;
}

async function buildPostCompactionFileExcerpts(
  workspaceDir: string,
  details: unknown,
): Promise<string | null> {
  if (!details || typeof details !== "object") {
    return null;
  }

  const modifiedFiles = normalizeWorkspaceFileList(
    (details as { modifiedFiles?: unknown }).modifiedFiles,
  );
  const readFiles = normalizeWorkspaceFileList((details as { readFiles?: unknown }).readFiles);
  const candidates = Array.from(new Set([...modifiedFiles, ...readFiles]));
  if (candidates.length === 0) {
    return null;
  }

  const blocks: string[] = [];
  let usedChars = 0;
  for (const candidate of candidates) {
    if (blocks.length >= MAX_FILE_EXCERPTS) {
      break;
    }

    const absolutePath = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(workspaceDir, candidate);
    const opened = await openBoundaryFile({
      absolutePath,
      rootPath: workspaceDir,
      boundaryLabel: "workspace root",
      maxBytes: 128 * 1024,
    });
    if (!opened.ok) {
      continue;
    }

    const content = (() => {
      try {
        return fs.readFileSync(opened.fd, "utf-8");
      } finally {
        fs.closeSync(opened.fd);
      }
    })();
    if (content.includes("\u0000")) {
      continue;
    }

    const excerpt = truncateFileExcerpt(content);
    if (!excerpt) {
      continue;
    }
    const relativePath =
      path.relative(opened.rootRealPath, opened.path) || path.basename(opened.path);
    const block = `<file path="${relativePath}">\n${excerpt}\n</file>`;
    const projectedChars = usedChars + block.length;
    if (projectedChars > MAX_FILE_EXCERPTS_TOTAL_CHARS) {
      break;
    }
    blocks.push(block);
    usedChars = projectedChars;
  }

  if (blocks.length === 0) {
    return null;
  }

  return ["Recent file excerpts from before compaction:", ...blocks].join("\n\n");
}

async function buildPostCompactionSkillExcerpts(params: {
  workspaceDir: string;
  details: unknown;
  skillsSnapshot?: SkillSnapshot;
}): Promise<string | null> {
  const { skillsSnapshot } = params;
  if (
    !params.details ||
    typeof params.details !== "object" ||
    !skillsSnapshot?.resolvedSkills?.length
  ) {
    return null;
  }

  const referencedPaths = new Set(
    [
      ...normalizeWorkspaceFileList((params.details as { modifiedFiles?: unknown }).modifiedFiles),
      ...normalizeWorkspaceFileList((params.details as { readFiles?: unknown }).readFiles),
    ].map((entry) =>
      path.isAbsolute(entry) ? path.normalize(entry) : path.resolve(params.workspaceDir, entry),
    ),
  );
  if (referencedPaths.size === 0) {
    return null;
  }

  const blocks: string[] = [];
  const seenPaths = new Set<string>();
  let usedChars = 0;
  for (const skill of skillsSnapshot.resolvedSkills) {
    const skillPathRaw = skill.filePath?.trim();
    const skillName = skill.name?.trim();
    if (!skillPathRaw || !skillName) {
      continue;
    }

    const skillPath = path.normalize(skillPathRaw);
    if (!referencedPaths.has(skillPath) || seenPaths.has(skillPath)) {
      continue;
    }
    seenPaths.add(skillPath);

    const relativeToWorkspace = path.relative(params.workspaceDir, skillPath);
    const isInsideWorkspace =
      relativeToWorkspace !== "" &&
      !relativeToWorkspace.startsWith("..") &&
      !path.isAbsolute(relativeToWorkspace);
    if (isInsideWorkspace) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(skillPath, "utf-8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) {
      continue;
    }

    const excerpt = truncateSkillExcerpt(content);
    if (!excerpt) {
      continue;
    }
    const block = `<skill name="${skillName}" path="${skillPath}">\n${excerpt}\n</skill>`;
    const projectedChars = usedChars + block.length;
    if (projectedChars > MAX_SKILL_EXCERPTS_TOTAL_CHARS) {
      break;
    }
    blocks.push(block);
    usedChars = projectedChars;
    if (blocks.length >= MAX_SKILL_EXCERPTS) {
      break;
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  return ["Recent skill excerpts from before compaction:", ...blocks].join("\n\n");
}

// Compare configured section names as a case-insensitive set so deployments can
// pin the documented defaults in any order without changing fallback semantics.
function matchesSectionSet(sectionNames: string[], expectedSections: string[]): boolean {
  if (sectionNames.length !== expectedSections.length) {
    return false;
  }

  const counts = new Map<string, number>();
  for (const name of expectedSections) {
    const normalized = name.trim().toLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  for (const name of sectionNames) {
    const normalized = name.trim().toLowerCase();
    const count = counts.get(normalized);
    if (!count) {
      return false;
    }
    if (count === 1) {
      counts.delete(normalized);
    } else {
      counts.set(normalized, count - 1);
    }
  }

  return counts.size === 0;
}

function formatDateStamp(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Read critical sections from workspace AGENTS.md for post-compaction injection.
 * Returns formatted system event text, or null if no AGENTS.md or no relevant sections.
 * Substitutes YYYY-MM-DD placeholders with the real date so agents read the correct
 * daily memory files instead of guessing based on training cutoff.
 */
export async function readPostCompactionContext(
  workspaceDir: string,
  cfg?: OpenClawConfig,
  nowMs?: number,
  workspaceDetails?: unknown,
  skillsSnapshot?: SkillSnapshot,
): Promise<string | null> {
  const agentsPath = path.join(workspaceDir, "AGENTS.md");
  const fileExcerpts = await buildPostCompactionFileExcerpts(workspaceDir, workspaceDetails);
  const skillExcerpts = await buildPostCompactionSkillExcerpts({
    workspaceDir,
    details: workspaceDetails,
    skillsSnapshot,
  });
  const fallbackFromFileExcerpts = () =>
    fileExcerpts || skillExcerpts
      ? [
          "[Post-compaction context refresh]",
          [fileExcerpts, skillExcerpts].filter(Boolean).join("\n\n"),
          resolveCronStyleNow(cfg ?? {}, nowMs ?? Date.now()).timeLine,
        ].join("\n\n")
      : null;

  try {
    const opened = await openBoundaryFile({
      absolutePath: agentsPath,
      rootPath: workspaceDir,
      boundaryLabel: "workspace root",
    });
    if (!opened.ok) {
      return fallbackFromFileExcerpts();
    }
    const content = (() => {
      try {
        return fs.readFileSync(opened.fd, "utf-8");
      } finally {
        fs.closeSync(opened.fd);
      }
    })();

    // Extract configured sections from AGENTS.md (default: Session Startup + Red Lines).
    // An explicit empty array disables post-compaction context injection entirely.
    const configuredSections = cfg?.agents?.defaults?.compaction?.postCompactionSections;
    const sectionNames = Array.isArray(configuredSections)
      ? configuredSections
      : DEFAULT_POST_COMPACTION_SECTIONS;

    if (sectionNames.length === 0) {
      return null;
    }

    const foundSectionNames: string[] = [];
    let sections = extractSections(content, sectionNames, foundSectionNames);

    // Fall back to legacy section names ("Every Session" / "Safety") when using
    // defaults and the current headings aren't found — preserves compatibility
    // with older AGENTS.md templates. The fallback also applies when the user
    // explicitly configures the default pair, so that pinning the documented
    // defaults never silently changes behavior vs. leaving the field unset.
    const isDefaultSections =
      !Array.isArray(configuredSections) ||
      matchesSectionSet(configuredSections, DEFAULT_POST_COMPACTION_SECTIONS);
    if (sections.length === 0 && isDefaultSections) {
      sections = extractSections(content, LEGACY_POST_COMPACTION_SECTIONS, foundSectionNames);
    }

    if (sections.length === 0 && !fileExcerpts && !skillExcerpts) {
      return null;
    }

    // Only reference section names that were actually found and injected.
    const displayNames = foundSectionNames.length > 0 ? foundSectionNames : sectionNames;

    const resolvedNowMs = nowMs ?? Date.now();
    const timezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
    const dateStamp = formatDateStamp(resolvedNowMs, timezone);
    // Always append the real runtime timestamp — AGENTS.md content may itself contain
    // "Current time:" as user-authored text, so we must not gate on that substring.
    const { timeLine } = resolveCronStyleNow(cfg ?? {}, resolvedNowMs);

    const combined = sections.join("\n\n").replaceAll("YYYY-MM-DD", dateStamp);
    const safeContent =
      combined.length > MAX_CONTEXT_CHARS
        ? combined.slice(0, MAX_CONTEXT_CHARS) + "\n...[truncated]..."
        : combined;

    // When using the default section set, use precise prose that names the
    // "Session Startup" sequence explicitly. When custom sections are configured,
    // use generic prose — referencing a hardcoded "Session Startup" sequence
    // would be misleading for deployments that use different section names.
    const prose = isDefaultSections
      ? "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
        "Run your Session Startup sequence — read the required files before responding to the user."
      : `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. ` +
        `Re-read the sections injected below (${displayNames.join(", ")}) and follow your configured startup procedure before responding to the user.`;

    const sectionLabel = isDefaultSections
      ? "Critical rules from AGENTS.md:"
      : `Injected sections from AGENTS.md (${displayNames.join(", ")}):`;

    const segments = ["[Post-compaction context refresh]", prose];
    if (safeContent.trim().length > 0) {
      segments.push(`${sectionLabel}\n\n${safeContent}`);
    }
    if (fileExcerpts) {
      segments.push(fileExcerpts.replaceAll("YYYY-MM-DD", dateStamp));
    }
    if (skillExcerpts) {
      segments.push(skillExcerpts.replaceAll("YYYY-MM-DD", dateStamp));
    }
    segments.push(timeLine);
    return segments.join("\n\n");
  } catch {
    return fallbackFromFileExcerpts();
  }
}

/**
 * Extract named sections from markdown content.
 * Matches H2 (##) or H3 (###) headings case-insensitively.
 * Skips content inside fenced code blocks.
 * Captures until the next heading of same or higher level, or end of string.
 */
export function extractSections(
  content: string,
  sectionNames: string[],
  foundNames?: string[],
): string[] {
  const results: string[] = [];
  const lines = content.split("\n");

  for (const name of sectionNames) {
    let sectionLines: string[] = [];
    let inSection = false;
    let sectionLevel = 0;
    let inCodeBlock = false;

    for (const line of lines) {
      // Track fenced code blocks
      if (line.trimStart().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        if (inSection) {
          sectionLines.push(line);
        }
        continue;
      }

      // Skip heading detection inside code blocks
      if (inCodeBlock) {
        if (inSection) {
          sectionLines.push(line);
        }
        continue;
      }

      // Check if this line is a heading
      const headingMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/);

      if (headingMatch) {
        const level = headingMatch[1].length; // 2 or 3
        const headingText = headingMatch[2];

        if (!inSection) {
          // Check if this is our target section (case-insensitive)
          if (headingText.toLowerCase() === name.toLowerCase()) {
            inSection = true;
            sectionLevel = level;
            sectionLines = [line];
            continue;
          }
        } else {
          // We're in section — stop if we hit a heading of same or higher level
          if (level <= sectionLevel) {
            break;
          }
          // Lower-level heading (e.g., ### inside ##) — include it
          sectionLines.push(line);
          continue;
        }
      }

      if (inSection) {
        sectionLines.push(line);
      }
    }

    if (sectionLines.length > 0) {
      results.push(sectionLines.join("\n").trim());
      foundNames?.push(name);
    }
  }

  return results;
}
