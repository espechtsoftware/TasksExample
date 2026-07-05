/**
 * The "business logic" of this example: simulated long-running report
 * generation, driven by the MCP Tasks pattern (call-now / fetch-later).
 *
 * The worker runs *outside* any single HTTP request. That is the whole point
 * of Tasks: the tools/call that started the work returns a task handle
 * immediately, and the client polls tasks/get + tasks/result afterwards —
 * possibly hitting a different server instance. Everything the server needs
 * lives in the TaskStore (here in-memory; in production you'd back it with
 * Redis/Firestore so any instance can answer the poll).
 */
import type { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const STEPS = [
  'Collecting sources',
  'Analyzing data',
  'Drafting sections',
  'Reviewing draft',
  'Finalizing report'
] as const;

export interface ReportRecord {
  taskId: string;
  topic: string;
  requestedBy: string;
  status: 'working' | 'completed' | 'failed' | 'cancelled';
  step: number;
  totalSteps: number;
  stepLabel: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * Side registry with report-specific progress the dashboard UI displays.
 * The TaskStore only knows generic task status; domain-specific progress
 * (which step, who asked) is the application's job to track.
 */
export class ReportRegistry {
  private readonly reports = new Map<string, ReportRecord>();

  list(): ReportRecord[] {
    return [...this.reports.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(taskId: string): ReportRecord | undefined {
    return this.reports.get(taskId);
  }

  upsert(record: ReportRecord): void {
    this.reports.set(record.taskId, record);
  }
}

export interface GenerateReportArgs {
  topic: string;
  /** Milliseconds per simulated step; small values make tests fast. */
  stepDurationMs: number;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Simulates the long-running work. Between steps it re-reads the task from
 * the store so a client-issued tasks/cancel actually stops the work — cancel
 * is cooperative in MCP Tasks, exactly like AbortSignal in plain Node.
 */
export async function runReportGeneration(
  store: InMemoryTaskStore,
  registry: ReportRegistry,
  taskId: string,
  args: GenerateReportArgs,
  requestedBy: string
): Promise<void> {
  const record: ReportRecord = {
    taskId,
    topic: args.topic,
    requestedBy,
    status: 'working',
    step: 0,
    totalSteps: STEPS.length,
    stepLabel: 'Starting',
    startedAt: new Date().toISOString()
  };
  registry.upsert(record);

  try {
    for (let i = 0; i < STEPS.length; i++) {
      const current = await store.getTask(taskId);
      if (!current || current.status === 'cancelled') {
        registry.upsert({ ...record, status: 'cancelled', finishedAt: new Date().toISOString() });
        return;
      }

      registry.upsert({ ...record, step: i, stepLabel: STEPS[i] });
      // statusMessage is the spec's channel for human-readable progress; it
      // shows up in tasks/get responses while status stays 'working'.
      await store.updateTaskStatus(taskId, 'working', `Step ${i + 1}/${STEPS.length}: ${STEPS[i]}`);
      await sleep(args.stepDurationMs);
    }

    const finishedAt = new Date().toISOString();
    const sections = STEPS.map((label, i) => ({
      title: `${i + 1}. ${label}`,
      body: `Simulated findings for "${args.topic}" produced during the "${label.toLowerCase()}" phase.`
    }));

    const result: CallToolResult = {
      content: [
        {
          type: 'text',
          text:
            `Report on "${args.topic}" (requested by ${requestedBy})\n\n` +
            sections.map(s => `${s.title}\n${s.body}`).join('\n\n')
        }
      ],
      structuredContent: {
        topic: args.topic,
        requestedBy,
        sections,
        startedAt: record.startedAt,
        finishedAt
      }
    };

    // storeTaskResult flips the task to its terminal status AND persists the
    // payload that tasks/result will return — one atomic concept in the spec.
    await store.storeTaskResult(taskId, 'completed', result);
    registry.upsert({
      ...record,
      status: 'completed',
      step: STEPS.length,
      stepLabel: 'Done',
      finishedAt
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.storeTaskResult(taskId, 'failed', {
      content: [{ type: 'text', text: `Report generation failed: ${message}` }],
      isError: true
    } satisfies CallToolResult);
    registry.upsert({ ...record, status: 'failed', stepLabel: message, finishedAt: new Date().toISOString() });
  }
}
