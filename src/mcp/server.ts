/**
 * MCP server definition for the model-training product:
 *
 *   list_products           browse the tiers
 *   purchase_training_plan  buy one (mock payment) → entitlement in Postgres
 *   upload_dataset          send CSV data (size-capped by tier)
 *   train_model             LONG-RUNNING TASK: AutoML over sklearn + XGBoost
 *   list_training_jobs      job status (also polled by the dashboard app)
 *   training_dashboard      MCP App: live progress UI in the host
 *   model://{jobId}         resource: download the fitted model (owner-only)
 *
 * A new McpServer instance is built per HTTP request (stateless Streamable
 * HTTP); everything durable lives in Postgres, the filesystem, and the
 * shared TaskStore passed in via deps.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { PaymentProvider } from '../payments.js';
import { PRODUCTS, getProduct, type Product } from '../products.js';
import { runTrainingJob } from './training.js';

export const DASHBOARD_RESOURCE_URI = 'ui://training-dashboard/view.html';

export interface McpDeps {
  taskStore: InMemoryTaskStore;
  taskMessageQueue: InMemoryTaskMessageQueue;
  db: Db;
  payments: PaymentProvider;
  dashboardHtml: string;
  /** Root directory for datasets, job configs and model artifacts. */
  dataDir: string;
  pythonBin: string;
}

/** Every tool is keyed to the verified caller from the bearer token. */
function identity(authInfo: AuthInfo | undefined): { subject: string; email?: string } {
  const subject = authInfo?.clientId;
  if (!subject) throw new Error('No verified identity on this request');
  const email = (authInfo.extra as { email?: string } | undefined)?.email;
  return { subject, email };
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Picks which active entitlement a new training run should be charged to:
 * the first one (newest first) that still has quota today and lifetime.
 * Returns the denial reasons if none qualifies, for a helpful error message.
 */
async function pickEntitlement(
  db: Db,
  subject: string
): Promise<{ entitlementId: string; product: Product } | { denied: string[] }> {
  const active = await db.activeEntitlements(subject);
  if (active.length === 0) {
    return { denied: ['No active training plan. Call purchase_training_plan first.'] };
  }
  const denied: string[] = [];
  for (const ent of active) {
    const product = getProduct(ent.product_id);
    if (!product) continue;
    const counts = await db.jobCounts(ent.id);
    if (product.totalTrainings !== null && counts.total >= product.totalTrainings) {
      denied.push(`${product.name}: lifetime limit of ${product.totalTrainings} training(s) used`);
      continue;
    }
    if (counts.today >= product.trainingsPerDay) {
      denied.push(`${product.name}: daily limit of ${product.trainingsPerDay} training(s) reached — retry tomorrow`);
      continue;
    }
    return { entitlementId: ent.id, product };
  }
  return { denied };
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'model-training-store', version: '0.2.0' },
    {
      capabilities: {
        tasks: {
          cancel: {},
          requests: { tools: { call: {} } }
        }
      },
      taskStore: deps.taskStore,
      taskMessageQueue: deps.taskMessageQueue,
      instructions:
        'Model-training-as-a-product. Flow: list_products → purchase_training_plan → ' +
        'upload_dataset (CSV) → train_model (long-running task; poll tasks/get, fetch via tasks/result) → ' +
        'download the fitted model from the model://{jobId} resource. ' +
        'Call training_dashboard to show live progress. All calls require a Google bearer token.'
    }
  );

  // --- Catalog & purchase -----------------------------------------------------

  server.registerTool(
    'list_products',
    {
      title: 'List training products',
      description: 'Shows the purchasable model-training tiers, their prices, quotas and dataset size limits.',
      inputSchema: {}
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: Object.values(PRODUCTS)
            .map(
              p =>
                `${p.id}: ${p.name} — $${p.priceUsd}. ${p.description} ` +
                `(${p.trainingsPerDay}/day${p.totalTrainings ? `, ${p.totalTrainings} total` : ''}, ` +
                `datasets up to ${(p.maxDatasetBytes / 1024 / 1024).toFixed(0)} MB, valid ${p.validDays} days)`
            )
            .join('\n')
        }
      ],
      structuredContent: { products: Object.values(PRODUCTS) }
    })
  );

  server.registerTool(
    'purchase_training_plan',
    {
      title: 'Purchase a training plan',
      description:
        'Buys one of the training tiers for the authenticated caller (payment is simulated in this example). ' +
        'Records the transaction and creates the entitlement that train_model checks.',
      inputSchema: {
        product_id: z.enum(['basic', 'standard', 'pro']).describe('Tier from list_products')
      }
    },
    async ({ product_id }, extra) => {
      const { subject, email } = identity(extra.authInfo);
      const product = getProduct(product_id)!;

      await deps.db.upsertCustomer(subject, email);
      const charge = await deps.payments.charge({ customerSubject: subject, customerEmail: email, product });

      const transactionId = randomUUID();
      const entitlementId = randomUUID();
      const expiresAt = new Date(Date.now() + product.validDays * 24 * 60 * 60 * 1000);
      await deps.db.recordPurchase({
        transactionId,
        entitlementId,
        subject,
        productId: product.id,
        amountUsd: product.priceUsd,
        receiptId: charge.receiptId,
        status: charge.status,
        expiresAt
      });
      await deps.db.logEvent(subject, 'purchase', { transactionId, productId: product.id, receipt: charge.receiptId });

      if (charge.status !== 'succeeded') {
        return toolError(`Payment declined: ${charge.detail}`);
      }
      return {
        content: [
          {
            type: 'text',
            text:
              `Purchased "${product.name}" — receipt ${charge.receiptId}. ` +
              `Entitlement ${entitlementId} is active until ${expiresAt.toISOString()}. ` +
              'Next: upload_dataset, then train_model.'
          }
        ],
        structuredContent: {
          transactionId,
          entitlementId,
          product: product.id,
          expiresAt: expiresAt.toISOString(),
          receipt: charge.receiptId
        }
      };
    }
  );

  // --- Dataset upload -----------------------------------------------------------

  server.registerTool(
    'upload_dataset',
    {
      title: 'Upload a training dataset',
      description:
        'Uploads CSV data (first row must be the header). In host apps, attach a file to the conversation ' +
        'and pass its content here. Size is capped by your purchased tier. Returns the dataset id and ' +
        'detected columns so you can pick the target for train_model.',
      inputSchema: {
        name: z.string().min(1).max(200).describe('A label for this dataset'),
        csv_data: z.string().min(1).describe('The raw CSV content, including the header row')
      }
    },
    async ({ name, csv_data }, extra) => {
      const { subject, email } = identity(extra.authInfo);
      await deps.db.upsertCustomer(subject, email);

      // Product gating: uploads only make sense with a plan, and the plan
      // decides how much data we accept. Cheapest check first.
      const active = await deps.db.activeEntitlements(subject);
      if (active.length === 0) {
        return toolError('No active training plan. Call purchase_training_plan first.');
      }
      const maxBytes = Math.max(
        ...active.map(ent => getProduct(ent.product_id)?.maxDatasetBytes ?? 0)
      );
      const bytes = Buffer.byteLength(csv_data, 'utf8');
      if (bytes > maxBytes) {
        return toolError(
          `Dataset is ${(bytes / 1024 / 1024).toFixed(2)} MB but your plan allows at most ` +
            `${(maxBytes / 1024 / 1024).toFixed(0)} MB. Trim the data or upgrade the plan.`
        );
      }

      const header = csv_data.slice(0, csv_data.indexOf('\n'));
      const columns = header.split(',').map(c => c.trim().replace(/^"|"$/g, '')).filter(Boolean);
      if (columns.length < 2) {
        return toolError('Could not detect a CSV header with at least 2 columns in the first line.');
      }

      const datasetId = randomUUID();
      const datasetDir = path.join(deps.dataDir, 'datasets');
      await mkdir(datasetDir, { recursive: true });
      const filePath = path.join(datasetDir, `${datasetId}.csv`);
      await writeFile(filePath, csv_data, 'utf8');

      await deps.db.createDataset({ id: datasetId, subject, name, path: filePath, bytes, columns });
      // "Once received, the transaction should be logged" — the receipt event:
      await deps.db.logEvent(subject, 'dataset_received', { datasetId, name, bytes, columns: columns.length });

      return {
        content: [
          {
            type: 'text',
            text: `Dataset "${name}" stored as ${datasetId} (${(bytes / 1024).toFixed(1)} KB, ${columns.length} columns: ${columns.join(', ')}).`
          }
        ],
        structuredContent: { datasetId, bytes, columns }
      };
    }
  );

  // --- The long-running training task ---------------------------------------------

  server.experimental.tasks.registerToolTask(
    'train_model',
    {
      title: 'Train a model (async)',
      description:
        'Trains a model on an uploaded dataset as a long-running task. The background worker analyzes ' +
        'the data, cross-validates scikit-learn and XGBoost candidates, picks the best one, and saves a ' +
        'deployable joblib pipeline. Poll with tasks/get; fetch the outcome with tasks/result; download ' +
        'the artifact from the model://{jobId} resource. Requires an active plan with remaining quota.',
      inputSchema: {
        dataset_id: z.string().describe('Id returned by upload_dataset'),
        target_column: z.string().describe('Column the model should predict'),
        problem_type: z
          .enum(['classification', 'regression', 'auto'])
          .default('auto')
          .describe('Expected outcome type; auto lets the analyzer decide from the target column')
      },
      execution: { taskSupport: 'required' }
    },
    {
      createTask: async (args, extra) => {
        // Refusals (no plan, quota spent, bad dataset) still answer with a
        // task — created and immediately failed with the reason. Throwing
        // here would get wrapped into a plain CallToolResult by the
        // (experimental) SDK, which task-aware clients cannot parse as a
        // CreateTaskResult; an instantly-failed task travels cleanly.
        const refuse = async (message: string) => {
          const task = await extra.taskStore!.createTask({ ttl: 60_000 });
          // Clients polling tasks/get only see statusMessage (a failed task's
          // result payload is never fetched), so put the reason there while
          // the task is still non-terminal, then flip it to failed.
          await deps.taskStore.updateTaskStatus(task.taskId, 'working', message);
          await deps.taskStore.storeTaskResult(task.taskId, 'failed', toolError(message));
          return { task };
        };

        const { subject, email } = identity(extra.authInfo);
        await deps.db.upsertCustomer(subject, email);

        const picked = await pickEntitlement(deps.db, subject);
        if ('denied' in picked) {
          return refuse(`Training not allowed: ${picked.denied.join('; ')}`);
        }
        const dataset = await deps.db.getDataset(args.dataset_id, subject);
        if (!dataset) {
          return refuse(`Dataset ${args.dataset_id} not found for this account. Call upload_dataset first.`);
        }
        if (dataset.columns && !dataset.columns.includes(args.target_column)) {
          return refuse(
            `Column "${args.target_column}" is not in this dataset. Available: ${dataset.columns.join(', ')}`
          );
        }

        const task = await extra.taskStore!.createTask({ ttl: 30 * 60 * 1000 });

        // The task id doubles as the job id: one identifier from tools/call
        // all the way to the model:// download.
        await deps.db.createJob({
          id: task.taskId,
          subject,
          entitlementId: picked.entitlementId,
          datasetId: dataset.id,
          targetColumn: args.target_column,
          problemType: args.problem_type
        });
        await deps.db.logEvent(subject, 'training_started', {
          jobId: task.taskId,
          datasetId: dataset.id,
          plan: picked.product.id
        });

        void runTrainingJob(
          { taskStore: deps.taskStore, db: deps.db, dataDir: deps.dataDir, pythonBin: deps.pythonBin },
          {
            jobId: task.taskId,
            subject,
            csvPath: dataset.path,
            targetColumn: args.target_column,
            problemType: args.problem_type
          }
        );

        return { task };
      },
      getTask: async (_args, extra) => extra.taskStore!.getTask(extra.taskId!),
      getTaskResult: async (_args, extra) =>
        (await extra.taskStore!.getTaskResult(extra.taskId!)) as CallToolResult
    }
  );

  // --- Job listing (model + dashboard both use this) --------------------------------

  server.registerTool(
    'list_training_jobs',
    {
      title: 'List training jobs',
      description: 'Shows the authenticated caller’s training jobs, newest first, with live progress and metrics.',
      inputSchema: {}
    },
    async (_args, extra) => {
      const { subject } = identity(extra.authInfo);
      const jobs = (await deps.db.listJobs(subject)).map(j => ({
        jobId: j.id,
        status: j.status,
        progress: j.progress_message,
        targetColumn: j.target_column,
        problemType: j.resolved_type ?? j.problem_type,
        bestModel: j.best_model,
        metrics: j.metrics,
        modelResourceUri: j.status === 'completed' ? `model://${j.id}` : null,
        createdAt: j.created_at,
        finishedAt: j.finished_at
      }));
      return {
        content: [
          {
            type: 'text',
            text: jobs.length
              ? jobs
                  .map(j => `${j.jobId.slice(0, 8)}… → ${j.targetColumn} [${j.status}] ${j.progress ?? ''}`)
                  .join('\n')
              : 'No training jobs yet.'
          }
        ],
        structuredContent: { jobs }
      };
    }
  );

  // --- MCP App: live training dashboard ------------------------------------------------

  registerAppTool(
    server,
    'training_dashboard',
    {
      title: 'Training dashboard',
      description: 'Shows an interactive dashboard of your training jobs with live status, metrics and download links.',
      inputSchema: {},
      _meta: { ui: { resourceUri: DASHBOARD_RESOURCE_URI } }
    },
    async (_args, extra) => {
      const { subject } = identity(extra.authInfo);
      const jobs = await deps.db.listJobs(subject);
      return {
        content: [{ type: 'text', text: 'Training dashboard opened.' }],
        structuredContent: {
          jobs: jobs.map(j => ({
            jobId: j.id,
            status: j.status,
            progress: j.progress_message,
            targetColumn: j.target_column,
            problemType: j.resolved_type ?? j.problem_type,
            bestModel: j.best_model,
            metrics: j.metrics
          }))
        }
      };
    }
  );

  registerAppResource(
    server,
    'Training dashboard view',
    DASHBOARD_RESOURCE_URI,
    { description: 'HTML view for the training dashboard app' },
    async uri => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: deps.dashboardHtml }]
    })
  );

  // --- Model download -------------------------------------------------------------------
  //
  // The deliverable. Ownership is enforced with the same bearer identity as
  // everything else: you can only read models from jobs you paid for.
  server.registerResource(
    'trained-model',
    new ResourceTemplate('model://{jobId}', { list: undefined }),
    {
      title: 'Trained model artifact',
      description:
        'Fitted model bundle for a completed training job (joblib: sklearn Pipeline + label encoder + metadata). ' +
        'Load with joblib.load() and call bundle["pipeline"].predict(df).',
      mimeType: 'application/octet-stream'
    },
    async (uri, variables, extra) => {
      const { subject } = identity(extra.authInfo);
      const jobId = String(variables.jobId);
      const job = await deps.db.getJob(jobId, subject);
      if (!job) throw new Error(`No training job ${jobId} for this account`);
      if (job.status !== 'completed' || !job.model_path) {
        throw new Error(`Job ${jobId} is ${job.status}; the model is only downloadable once completed`);
      }
      const artifact = await readFile(job.model_path);
      await deps.db.logEvent(subject, 'model_downloaded', { jobId });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/octet-stream',
            blob: artifact.toString('base64')
          }
        ]
      };
    }
  );

  return server;
}
