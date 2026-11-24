/**
 * Worker prompt and the structured final-report contract. The report is asked for as the
 * agent's final answer (never as a file inside the workspace) and is always treated as
 * untrusted agent claims, never as bridge-verified facts.
 */

import type { AgentReport } from './types.ts';
import { emptyReport } from './state.ts';
import { truncate } from './util.ts';

export const REPORT_INSTRUCTIONS = `
BRIDGE PROTOCOL (read carefully)

You are a shrimp-pi worker running inside a disposable copy of the repository, in the current
working directory. A supervisor process drives you over the Pi RPC protocol and cannot see
your terminal; it only reads your final answer plus the git diff it computes itself.

1. Do the work with the normal tools. Stay inside the current working directory. Do not push,
   publish, or contact services other than your configured model endpoint.
2. Run the project's own tests/build/checks with the bash tool when they exist, and report what
   you actually observed. Never invent test counts, pass rates, or commands you did not run.
3. Your FINAL answer must end with exactly one JSON object in a fenced \`\`\`json block, with
   these fields:
   {
     "status": "review" | "blocked" | "checkpoint",
     "workCompleted": "short factual summary of what you changed",
     "tests": [{"name": "string", "command": "string", "status": "passed|failed|not_run|unclear", "summary": "string"}],
     "decisions": ["design decision you made and why"],
     "outstandingProblems": ["known problems, failures, or gaps"],
     "questions": ["questions for the supervisor"]
   }
   - "review": you believe the work is ready for the supervisor to review.
   - "blocked": you cannot continue without input, credentials, or a decision.
   - "checkpoint": you made partial progress and are stopping on purpose; say what is next.
4. Do not write the report to a file in the workspace. The final answer is the report.
5. Before you report "review" or "checkpoint", commit all of your changes on the current branch
   with git (git add -A, then git commit with a message describing the change), so the work is
   ready to merge. Make new commits after corrections too. Do not create or switch branches,
   amend or rebase commits you did not make, or push. Leave build output and other generated
   files out of the commit unless the task needs them.
6. If you are steered mid-run, the steering message overrides earlier instructions.
`.trim();

/** Told to the worker when its model has a per-reply output limit: a reply cut off there has no report. */
export function outputLimitNote(maxTokens: number): string {
  return (
    `7. Each of your replies is limited to ${maxTokens} output tokens, thinking included. A reply that ` +
    'reaches the limit is cut off and the supervisor sees no report. Keep thinking brief, and write a ' +
    'large file in several steps (create it, then append or edit) instead of in one tool call.'
  );
}

export function buildTaskPrompt(taskText: string, maxTokens: number | null = null): string {
  const limit = maxTokens ? `\n${outputLimitNote(maxTokens)}` : '';
  return `TASK (from supervisor)\n${taskText.trim()}\n\n${REPORT_INSTRUCTIONS}${limit}`;
}

export function buildResumeNotice(context: { workerId: string; state: string }): string {
  return `shrimp-pi recovered this worker after its process was interrupted (worker ${context.workerId}, state ${context.state}). The session history is intact. Nothing was replayed: no earlier prompt, tool command, or side effect was repeated. Wait for the supervisor's next instruction before doing anything.`;
}

function stripFences(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  let match = re.exec(text);
  while (match) {
    blocks.push(match[1] as string);
    match = re.exec(text);
  }
  return blocks;
}

/** Find the last balanced top-level JSON object in a text blob. */
function lastJsonObject(text: string): string | null {
  for (let end = text.length - 1; end >= 0; end -= 1) {
    if (text[end] !== '}') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = end; i >= Math.max(0, end - 200_000); i -= 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '}') depth += 1;
      else if (ch === '{') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(i, end + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return candidate;
          } catch {
            /* keep scanning */
          }
        }
      }
    }
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

export type ParsedReport = AgentReport;

/** Parse the agent's final answer. Missing/invalid report is never treated as success. */
export function parseAgentReport(text: string | null): ParsedReport {
  const report = emptyReport();
  report.rawText = text ? truncate(text, 60_000) : '';
  if (!text || !text.trim()) {
    report.parseNotes.push('agent produced no final text');
    return report;
  }
  const candidates: string[] = [];
  const trimmed = text.trim();
  candidates.push(trimmed);
  candidates.push(...stripFences(text).reverse());
  const balanced = lastJsonObject(text);
  if (balanced) candidates.push(balanced);

  let parsed: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    if (!candidate || !candidate.includes('{')) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
        break;
      }
    } catch {
      /* try next candidate */
    }
  }
  if (!parsed) {
    report.parseNotes.push('no JSON object report found in the final answer');
    return report;
  }
  const status = parsed.status;
  if (status === 'review' || status === 'blocked' || status === 'checkpoint') {
    report.status = status;
  } else {
    report.parseNotes.push(`report status ${JSON.stringify(status ?? null)} is not one of review|blocked|checkpoint`);
  }
  report.workCompleted = typeof parsed.workCompleted === 'string' ? truncate(parsed.workCompleted, 4000) : null;
  if (report.workCompleted === null) report.parseNotes.push('report has no string workCompleted');
  report.tests = asArray(parsed.tests).slice(0, 50);
  report.decisions = asArray(parsed.decisions).slice(0, 50);
  report.outstandingProblems = asArray(parsed.outstandingProblems).slice(0, 50);
  report.questions = asArray(parsed.questions).slice(0, 50);
  report.parsed = report.status !== null;
  return report;
}

export function summarizeReport(report: ParsedReport | null): string {
  if (!report || !report.parsed) return 'no structured agent report';
  return `agent status ${report.status}: ${report.workCompleted ?? 'no summary'}`;
}
