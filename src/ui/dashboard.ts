/**
 * Iframe-side code for the report dashboard MCP App.
 *
 * Runs inside the host's sandboxed iframe. The App class speaks JSON-RPC to
 * the host over postMessage — the same base protocol as the rest of MCP —
 * which is why every action here (like the list_report_tasks polling) goes
 * through the host's normal tool-call consent/audit path.
 */
import { App } from '@modelcontextprotocol/ext-apps';

interface ReportRecord {
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

const POLL_MS = 2000;
const subtitle = document.getElementById('subtitle')!;
const container = document.getElementById('reports')!;

function render(reports: ReportRecord[]): void {
  if (reports.length === 0) {
    container.innerHTML = '<div class="empty">No report tasks yet — ask the model to generate a report.</div>';
    return;
  }
  container.innerHTML = reports
    .map(r => {
      const pct = r.status === 'completed' ? 100 : Math.round((r.step / r.totalSteps) * 100);
      return `
        <div class="card">
          <div class="row">
            <span class="topic">${escapeHtml(r.topic)}</span>
            <span class="status ${r.status}">${r.status} — ${escapeHtml(r.stepLabel)}</span>
          </div>
          <div class="bar"><div style="width:${pct}%"></div></div>
          <div class="meta">task ${r.taskId.slice(0, 8)}… · requested by ${escapeHtml(r.requestedBy)}</div>
        </div>`;
    })
    .join('');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

const app = new App({ name: 'report-dashboard', version: '0.1.0' });

// The host pushes the report_dashboard tool's own result here right after
// render — that seeds the view before the first poll happens.
app.ontoolresult = result => {
  const data = result.structuredContent as { reports?: ReportRecord[] } | undefined;
  if (data?.reports) render(data.reports);
};

async function poll(): Promise<void> {
  try {
    // Proxied through the host to our MCP server; arrives there as a normal
    // authenticated tools/call.
    const result = await app.callServerTool({ name: 'list_report_tasks', arguments: {} });
    const data = result.structuredContent as { reports?: ReportRecord[] } | undefined;
    if (data?.reports) render(data.reports);
    subtitle.textContent = `Live — refreshes every ${POLL_MS / 1000}s (last: ${new Date().toLocaleTimeString()})`;
  } catch (err) {
    subtitle.textContent = `Polling failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

await app.connect();
subtitle.textContent = 'Connected. Loading…';
await poll();
setInterval(() => void poll(), POLL_MS);
