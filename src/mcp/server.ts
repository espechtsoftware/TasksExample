/**
 * MCP server definition: one long-running task tool (MCP Tasks), one MCP App
 * dashboard tool + its ui:// HTML resource, and one plain tool the dashboard
 * polls for live progress.
 *
 * A new McpServer instance is built per HTTP request (see src/index.ts) —
 * the stateless pattern the 2026 spec revisions push toward. All state that
 * must survive across requests (tasks, report progress) lives in the shared
 * dependencies passed in here, never in the server instance itself.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ReportRegistry, runReportGeneration } from './reports.js';

export const DASHBOARD_RESOURCE_URI = 'ui://report-dashboard/view.html';

export interface McpDeps {
  /** Shared across all per-request server instances so polling always works. */
  taskStore: InMemoryTaskStore;
  taskMessageQueue: InMemoryTaskMessageQueue;
  registry: ReportRegistry;
  /** Pre-built, self-contained HTML for the dashboard app (from `npm run build:ui`). */
  dashboardHtml: string;
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'gcp-tasks-example', version: '0.1.0' },
    {
      // Tasks must be declared as a capability during initialization —
      // clients only send task-augmented tools/call to servers that do.
      capabilities: {
        tasks: {
          cancel: {},
          requests: { tools: { call: {} } }
        }
      },
      // The task store/queue hang off protocol options; the SDK uses them to
      // answer tasks/get, tasks/result and tasks/cancel for us.
      taskStore: deps.taskStore,
      taskMessageQueue: deps.taskMessageQueue,
      instructions:
        'Report generation demo. Call generate_report to start a long-running task, ' +
        'poll it via tasks/get, then fetch the report with tasks/result. ' +
        'Call report_dashboard to show the live progress UI.'
    }
  );

  // --- Long-running task tool (MCP Tasks, call-now / fetch-later) ----------
  //
  // execution.taskSupport 'required' tells clients this tool ONLY runs as a
  // task: tools/call answers with a task handle instead of a result. The
  // three handler methods map 1:1 onto the task lifecycle RPCs.
  server.experimental.tasks.registerToolTask(
    'generate_report',
    {
      title: 'Generate report',
      description:
        'Starts a simulated multi-step report generation job. Returns a task handle immediately; ' +
        'poll with tasks/get and fetch the finished report with tasks/result.',
      inputSchema: {
        topic: z.string().min(1).describe('Subject of the report'),
        step_duration_ms: z
          .number()
          .int()
          .min(50)
          .max(10_000)
          .default(1_500)
          .describe('Simulated duration of each of the 5 steps')
      },
      execution: { taskSupport: 'required' }
    },
    {
      createTask: async (args, extra) => {
        // extra.taskStore is a request-scoped wrapper that records the
        // original request alongside the task, so a *different* server
        // instance can later route tasks/result back to this tool.
        const task = await extra.taskStore!.createTask({ ttl: 10 * 60 * 1000 });

        const requestedBy =
          (extra.authInfo?.extra as { email?: string } | undefined)?.email ??
          extra.authInfo?.clientId ??
          'unknown caller';

        // Fire-and-forget: the work continues after this HTTP response ends.
        void runReportGeneration(
          deps.taskStore,
          deps.registry,
          task.taskId,
          { topic: args.topic, stepDurationMs: args.step_duration_ms },
          requestedBy
        );

        return { task };
      },
      getTask: async (_args, extra) => extra.taskStore!.getTask(extra.taskId!),
      // The store persists whatever CallToolResult the worker saved.
      getTaskResult: async (_args, extra) =>
        (await extra.taskStore!.getTaskResult(extra.taskId!)) as CallToolResult
    }
  );

  // --- Plain tool: current progress of all report tasks ---------------------
  //
  // Called by the model like any tool, and ALSO by the dashboard iframe via
  // the host (app.callServerTool). Same audit path either way — that is a
  // core MCP Apps guarantee.
  server.registerTool(
    'list_report_tasks',
    {
      title: 'List report tasks',
      description: 'Returns progress of all report-generation tasks started in this server process.',
      inputSchema: {}
    },
    async () => {
      const reports = deps.registry.list();
      return {
        content: [
          {
            type: 'text',
            text: reports.length
              ? reports
                  .map(r => `${r.taskId.slice(0, 8)}… "${r.topic}" — ${r.status} (${r.stepLabel})`)
                  .join('\n')
              : 'No report tasks yet.'
          }
        ],
        structuredContent: { reports }
      };
    }
  );

  // --- MCP App: live dashboard ----------------------------------------------
  //
  // The tool's _meta.ui.resourceUri points at a ui:// resource; a compliant
  // host fetches that resource, renders it in a sandboxed iframe, and pipes
  // this tool's result into it (ui/notifications/tool-result).
  registerAppTool(
    server,
    'report_dashboard',
    {
      title: 'Report dashboard',
      description:
        'Shows an interactive dashboard of running and finished report-generation tasks with live progress bars.',
      inputSchema: {},
      _meta: { ui: { resourceUri: DASHBOARD_RESOURCE_URI } }
    },
    async () => ({
      content: [{ type: 'text', text: 'Report dashboard opened.' }],
      structuredContent: { reports: deps.registry.list() }
    })
  );

  // The HTML must be fully self-contained (scripts inlined by the build):
  // hosts render it inside a sandboxed iframe with a strict CSP, so there is
  // no fetching of external JS at render time.
  registerAppResource(
    server,
    'Report dashboard view',
    DASHBOARD_RESOURCE_URI,
    { description: 'HTML view for the report dashboard app' },
    async uri => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: deps.dashboardHtml }]
    })
  );

  return server;
}
