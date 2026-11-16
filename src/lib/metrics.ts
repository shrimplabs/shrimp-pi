import type { WorkerState } from './types.ts';

/** Observations only; no model-cost estimates or inferred test pass counts. */
export function workerMetrics(state: WorkerState, now = Date.now()): Record<string, number | string | boolean | null> {
  const terminalAt = state.accept?.acceptedAt
    ?? [...state.events].reverse().find((event) => event.to === state.state)?.at
    ?? state.updatedAt;
  const end = ['COMPLETED', 'FAILED', 'STOPPED'].includes(state.state)
    ? Date.parse(terminalAt) : now;
  const seconds = (start: string, finish: number) => Math.max(0, (finish - Date.parse(start)) / 1000);
  const runSeconds = state.runs.reduce((sum, run) => sum + seconds(run.startedAt,
    run.endedAt ? Date.parse(run.endedAt) : end), 0);
  return {
    elapsedSeconds: seconds(state.createdAt, end),
    observedRunSeconds: Math.round(runSeconds * 1000) / 1000,
    retainedRunCount: state.runs.length,
    retainedInterventions: state.interventions.length,
    failedToolAttempts: state.tool.failures,
    workerTokens: state.usage.totalTokens,
    supervisorTokens: null,
    testsPassed: null,
    testsFailed: null,
    accepted: state.state === 'COMPLETED',
    historyScope: 'retained runs and interventions; full history remains in raw logs',
  };
}
