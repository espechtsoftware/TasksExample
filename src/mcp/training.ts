/**
 * The asynchronous training worker: bridges a Python child process
 * (scikit-learn + XGBoost, see python/train.py) to the MCP Task lifecycle
 * and the Postgres job record.
 *
 * Runs after the originating tools/call has already been answered with a
 * task handle. Progress flows three ways simultaneously:
 *   - TaskStore.updateTaskStatus → what MCP clients see when they poll tasks/get
 *   - Db.updateJobProgress       → the durable record (and the dashboard app)
 *   - stdout JSON lines          → parsed from the Python process as they happen
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '../db.js';

export interface TrainingJobConfig {
  jobId: string; // == the MCP taskId
  subject: string;
  csvPath: string;
  targetColumn: string;
  problemType: 'classification' | 'regression' | 'auto';
}

export interface TrainingDeps {
  taskStore: InMemoryTaskStore;
  db: Db;
  /** Root for job configs + model artifacts (var/ locally). */
  dataDir: string;
  pythonBin: string;
}

interface TrainerEvent {
  event: 'progress' | 'result' | 'error';
  stage?: string;
  message?: string;
  resolved_type?: string;
  best_model?: string;
  metrics?: Record<string, unknown>;
}

/** Map the trainer's stage names onto the job-status vocabulary in the DB. */
const STAGE_TO_STATUS: Record<string, string> = {
  loading: 'analyzing',
  analyzing: 'analyzing',
  training: 'training',
  finalizing: 'training'
};

export async function runTrainingJob(deps: TrainingDeps, config: TrainingJobConfig): Promise<void> {
  const { jobId } = config;
  const jobDir = path.join(deps.dataDir, 'jobs');
  const modelDir = path.join(deps.dataDir, 'models');
  await mkdir(jobDir, { recursive: true });
  await mkdir(modelDir, { recursive: true });

  const modelPath = path.join(modelDir, `${jobId}.joblib`);
  const configPath = path.join(jobDir, `${jobId}.json`);
  await writeFile(
    configPath,
    JSON.stringify({
      csv_path: config.csvPath,
      target_column: config.targetColumn,
      problem_type: config.problemType,
      output_path: modelPath
    })
  );

  const trainerScript = path.resolve(process.cwd(), 'python/train.py');
  const child = spawn(deps.pythonBin, [trainerScript, '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderrTail = '';
  child.stderr.on('data', chunk => {
    stderrTail = (stderrTail + String(chunk)).slice(-2000);
  });

  let result: TrainerEvent | undefined;
  let errorEvent: TrainerEvent | undefined;

  const finishFailed = async (status: 'failed' | 'cancelled', message: string) => {
    await deps.db.failJob(jobId, status, message);
    await deps.db.logEvent(config.subject, `training_${status}`, { jobId, message });
    if (status === 'cancelled') {
      // tasks/cancel already flipped the task's status; just record it.
      return;
    }
    // Surface the reason via statusMessage (what tasks/get pollers see),
    // then flip to failed with the result payload.
    await deps.taskStore.updateTaskStatus(jobId, 'working', `Training failed: ${message}`);
    await deps.taskStore.storeTaskResult(jobId, 'failed', {
      content: [{ type: 'text', text: `Training failed: ${message}` }],
      isError: true
    } satisfies CallToolResult);
  };

  try {
    for await (const line of createInterface({ input: child.stdout })) {
      let event: TrainerEvent;
      try {
        event = JSON.parse(line) as TrainerEvent;
      } catch {
        continue; // ignore anything that isn't protocol JSON
      }

      if (event.event === 'progress') {
        // Cooperative cancellation: tasks/cancel flips the store status; we
        // notice on the next progress tick and stop paying for compute.
        const task = await deps.taskStore.getTask(jobId);
        if (!task || task.status === 'cancelled') {
          child.kill('SIGKILL');
          await finishFailed('cancelled', 'Cancelled by client');
          return;
        }
        const message = event.message ?? 'Working';
        await deps.db.updateJobProgress(jobId, STAGE_TO_STATUS[event.stage ?? ''] ?? 'training', message);
        await deps.taskStore.updateTaskStatus(jobId, 'working', message);
      } else if (event.event === 'result') {
        result = event;
      } else if (event.event === 'error') {
        errorEvent = event;
      }
    }

    const exitCode = await new Promise<number | null>(resolve => child.on('close', resolve));

    if (errorEvent || exitCode !== 0 || !result) {
      const message =
        errorEvent?.message ??
        `Trainer exited with code ${exitCode}${stderrTail ? ` — ${stderrTail.trim().slice(-300)}` : ''}`;
      await finishFailed('failed', message);
      return;
    }

    await deps.db.completeJob({
      id: jobId,
      resolvedType: result.resolved_type ?? config.problemType,
      bestModel: result.best_model ?? 'unknown',
      metrics: result.metrics ?? {},
      modelPath
    });
    await deps.db.logEvent(config.subject, 'training_completed', {
      jobId,
      bestModel: result.best_model,
      resolvedType: result.resolved_type
    });

    const modelResourceUri = `model://${jobId}`;
    await deps.taskStore.storeTaskResult(jobId, 'completed', {
      content: [
        {
          type: 'text',
          text:
            `Training complete. Best model: ${result.best_model} (${result.resolved_type}). ` +
            `Download the fitted pipeline via the MCP resource ${modelResourceUri} ` +
            '(joblib bundle: sklearn Pipeline + label encoder + metadata).'
        }
      ],
      structuredContent: {
        jobId,
        status: 'completed',
        resolvedType: result.resolved_type,
        bestModel: result.best_model,
        metrics: result.metrics,
        modelResourceUri
      }
    } satisfies CallToolResult);
  } catch (err) {
    child.kill('SIGKILL');
    await finishFailed('failed', err instanceof Error ? err.message : String(err));
  }
}
