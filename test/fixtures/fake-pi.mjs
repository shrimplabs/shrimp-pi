#!/usr/bin/env node
/**
 * Fake Pi RPC peer used by the test suite. It speaks the real framing and record shapes
 * (response / session events) so the daemon is exercised end to end without a model.
 *
 * Behaviour is selected with --scenario <name> (argv, so it survives the CLI -> detached
 * daemon -> child boundary without needing an inherited environment).
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:os';

const argv = process.argv.slice(2);
function argValue(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

const background = argValue('--spawn-background');
if (background && !fs.existsSync(background)) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(background, String(descendant.pid));
  descendant.unref();
}

const scenario = argValue('--scenario') ?? process.env.FAKE_PI_SCENARIO ?? 'ok';
const sessionFile = argValue('--session') ?? null;
const reportFile = process.env.FAKE_PI_REPORT_FILE ?? null;

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function logSession(entry) {
  if (!sessionFile) return;
  try {
    fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
  } catch {
    /* ignore */
  }
}

function assistantText(text, extra = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.01 } },
    ...extra,
  };
}

function reportJson(fields) {
  return `I finished the work.\n\n\`\`\`json\n${JSON.stringify(
    {
      status: 'review',
      workCompleted: 'added the feature and ran the tests',
      tests: [{ name: 'unit', command: 'node --test', status: 'passed', summary: 'observed locally by the agent' }],
      decisions: ['kept the change small'],
      outstandingProblems: [],
      questions: [],
      ...fields,
    },
    null,
    2,
  )}\n\`\`\``;
}

function runScenario(kind) {
  switch (kind) {
    case 'ok':
    case 'env':
    case 'untracked':
    case 'late_settle':
    case 'idle_exit':
    case 'steerable':
    case 'two_runs':
    case 'steer': {
      send({ type: 'agent_start' });
      send({ type: 'turn_start' });
      send({ type: 'message_end', message: { role: 'user', content: 'task', timestamp: Date.now() } });
      send({ type: 'message_end', message: assistantText(reportJson({})) });
      send({ type: 'turn_end', message: assistantText(reportJson({})), toolResults: [] });
      send({ type: 'agent_end', messages: [], willRetry: false });
      if (kind === 'late_settle') {
        // Follow-up work after agent_end: proves agent_end is not completion.
        setTimeout(() => {
          send({ type: 'message_end', message: assistantText(reportJson({ workCompleted: 'final answer after retry' })) });
          send({ type: 'agent_settled', aborted: false });
        }, 500);
        return;
      }
      send({ type: 'agent_settled', aborted: false });
      if (kind === 'idle_exit') setTimeout(() => process.exit(0), 300);
      return;
    }
    case 'blocked': {
      send({ type: 'agent_start' });
      send({ type: 'message_end', message: assistantText(reportJson({ status: 'blocked', outstandingProblems: ['need credentials'] })) });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled', aborted: false });
      return;
    }
    case 'checkpoint': {
      send({ type: 'agent_start' });
      send({
        type: 'message_end',
        message: assistantText(reportJson({ status: 'checkpoint', workCompleted: 'halfway, waiting for direction' })),
      });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled', aborted: false });
      return;
    }
    case 'no_report': {
      send({ type: 'agent_start' });
      send({ type: 'message_end', message: assistantText('I did some things and think it is probably fine.') });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled', aborted: false });
      return;
    }
    case 'provider_error': {
      send({ type: 'agent_start' });
      send({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'HTTP 503: provider overloaded',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        },
      });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled', aborted: false });
      return;
    }
    case 'toolfail': {
      send({ type: 'agent_start' });
      for (let i = 0; i < 6; i += 1) {
        const id = `call-${i}`;
        send({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: `false #${i}` } });
        send({
          type: 'tool_execution_end',
          toolCallId: id,
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'command failed' }] },
          isError: true,
          durationMs: 5,
        });
      }
      return;
    }
    case 'burst': {
      // A burst of failures and the settling event arrive in the same tick: the daemon must
      // ingest them in order and must not let the settle overwrite the abort reason.
      send({ type: 'agent_start' });
      for (let i = 0; i < 8; i += 1) {
        const id = `burst-${i}`;
        send({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: `exit 1 #${i}` } });
        send({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash', result: { content: [] }, isError: true, durationMs: 1 });
      }
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled', aborted: false });
      return;
    }
    case 'malformed': {
      process.stdout.write('this is not json at all\n');
      // U+2028 / U+2029 are valid inside JSON strings and must not split a record.
      send({
        type: 'message_end',
        message: assistantText(`line separator   and paragraph   separators are fine\n\n${reportJson({})}`),
      });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled', aborted: false });
      return;
    }
    case 'died': {
      setTimeout(() => process.exit(7), 100);
      return;
    }
    case 'hang': {
      send({ type: 'agent_start' });
      return;
    }
    case 'steer_reply': {
      send({ type: 'agent_start' });
      return;
    }
    default: {
      send({ type: 'agent_start' });
      send({ type: 'message_end', message: assistantText(reportJson({})) });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled', aborted: false });
    }
  }
}

if (process.env.FAKE_PI_ENV_FILE) {
  fs.writeFileSync(process.env.FAKE_PI_ENV_FILE, JSON.stringify(process.env, null, 2), { mode: 0o600 });
}

if (process.env.FAKE_PI_TOUCH) {
  fs.writeFileSync(process.env.FAKE_PI_TOUCH, 'created by the fake agent\n', { mode: 0o600 });
}

// Simulated work products: an untracked file and/or a real commit, driven by argv so they
// survive the CLI -> detached daemon -> sandboxed child boundary.
const touchPath = argValue('--touch');
if (touchPath) {
  const dir = path.posix.dirname(touchPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(touchPath, 'untracked file written by the fake agent\n', { mode: 0o600 });
}
const editPath = argValue('--edit');
if (editPath) {
  fs.appendFileSync(editPath, 'export const sum = (a, b) => a + b;\n');
}
if (argv.includes('--commit')) {
  const { spawnSync } = await import('node:child_process');
  const file = 'src/sum.ts';
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync(file, 'export const sum = (a: number, b: number): number => a + b;\n');
  const gitEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1' };
  const run = (args) => spawnSync('git', args, { encoding: 'utf8', env: gitEnv });
  run(['add', '-A']);
  const commit = run(['commit', '-q', '-m', 'worker: add sum helper']);
  fs.writeFileSync('.fake-pi-commit', commit.status === 0 ? 'committed\n' : `commit failed: ${commit.stderr}\n`, { mode: 0o600 });
}

try {
  fs.writeFileSync('.fake-pi-cwd', process.cwd(), { mode: 0o600 });
} catch {
  /* not writable in some probes */
}

logSession({ type: 'start', scenario, at: new Date().toISOString(), cwd: process.cwd(), host: net.hostname() });

let buffer = Buffer.alloc(0);
let prompts = 0;

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const index = buffer.indexOf(0x0a);
    if (index === -1) break;
    const line = buffer.subarray(0, index).toString('utf8').replace(/\r$/, '');
    buffer = buffer.subarray(index + 1);
    if (!line.trim()) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      send({ type: 'response', command: 'parse', success: false, error: 'Failed to parse command' });
      continue;
    }
    handle(command);
  }
});

function handle(command) {
  const id = typeof command.id === 'string' ? command.id : undefined;
  switch (command.type) {
    case 'get_state':
      send({
        id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: { id: 'fake-model', provider: 'bridge-local', api: 'openai-completions', contextWindow: 32000 },
          isStreaming: false,
          sessionFile: sessionFile ?? '(none)',
          sessionId: 'fake-session',
          messageCount: 0,
        },
      });
      return;
    case 'get_session_stats':
      // Pi computes `cost` from configured prices; it is not provider-billed.
      send({
        id,
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          tokens: { input: 1000, output: 250, cacheRead: 0, cacheWrite: 0, total: 1250 },
          cost: 0.042,
          contextUsage: { tokens: 1250, contextWindow: 32000, percent: 4 },
        },
      });
      return;
    case 'prompt': {
      prompts += 1;
      logSession({ type: 'prompt', index: prompts, text: String(command.message ?? ''), streamingBehavior: command.streamingBehavior ?? null, at: new Date().toISOString() });
      const steering = command.streamingBehavior === 'steer';
      send({
        id,
        type: 'response',
        command: 'prompt',
        success: true,
        data: { disposition: steering ? 'queued' : 'started' },
      });
      if (scenario === 'died') {
        runScenario('died');
        return;
      }
      if (scenario === 'hang') {
        runScenario('hang');
        return;
      }
      if (scenario === 'idle_exit' && prompts > 1) {
        // Relaunched after an idle exit: answer like a normal run.
        runScenario('ok');
        return;
      }
      if (scenario === 'toolfail' || scenario === 'burst' || scenario === 'malformed' || scenario === 'provider_error' || scenario === 'no_report' || scenario === 'blocked' || scenario === 'checkpoint') {
        runScenario(scenario);
        return;
      }
      if (scenario === 'steerable') {
        if (prompts === 1) {
          // First run never settles: the supervisor must steer.
          send({ type: 'agent_start' });
          return;
        }
        send({ type: 'agent_start' });
        send({
          type: 'message_end',
          message: assistantText(reportJson({ workCompleted: `steered: ${String(command.message ?? '').slice(0, 60)}` })),
        });
        send({ type: 'agent_end', messages: [], willRetry: false });
        send({ type: 'agent_settled', aborted: false });
        return;
      }
      if (scenario === 'two_runs') {
        send({ type: 'agent_start' });
        send({
          type: 'message_end',
          message: assistantText(reportJson({ workCompleted: prompts === 1 ? 'first run finished' : `second run finished (prompt ${prompts})` })),
        });
        send({ type: 'agent_end', messages: [], willRetry: false });
        send({ type: 'agent_settled', aborted: false });
        return;
      }
      if (steering) {
        send({ type: 'agent_start' });
        send({
          type: 'message_end',
          message: assistantText(reportJson({ workCompleted: `applied steering: ${String(command.message ?? '').slice(0, 40)}` })),
        });
        send({ type: 'agent_end', messages: [], willRetry: false });
        send({ type: 'agent_settled', aborted: false });
        return;
      }
      runScenario(scenario);
      return;
    }
    case 'steer':
      logSession({ type: 'steer', text: String(command.message ?? ''), at: new Date().toISOString() });
      send({ id, type: 'response', command: 'steer', success: true, data: { disposition: 'queued' } });
      return;
    case 'abort':
      send({ id, type: 'response', command: 'abort', success: true });
      send({ type: 'agent_settled', aborted: true });
      return;
    case 'get_last_assistant_text':
      send({ id, type: 'response', command: 'get_last_assistant_text', success: true, data: { text: null } });
      return;
    case 'get_messages':
      send({ id, type: 'response', command: 'get_messages', success: true, data: { messages: [] } });
      return;
    default:
      send({ id, type: 'response', command: String(command.type), success: false, error: `unsupported command ${command.type}` });
  }
}

process.stdin.on('end', () => process.exit(0));
