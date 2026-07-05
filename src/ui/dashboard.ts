/**
 * Iframe-side code for the training-dashboard MCP App.
 *
 * Runs inside the host's sandboxed iframe. The App class speaks JSON-RPC to
 * the host over postMessage — the same base protocol as the rest of MCP —
 * which is why every action here (like the list_training_jobs polling) goes
 * through the host's normal tool-call consent/audit path, carrying the same
 * bearer identity as model-initiated calls.
 */
import { App } from '@modelcontextprotocol/ext-apps';

interface JobView {
  jobId: string;
  status: 'received' | 'analyzing' | 'training' | 'completed' | 'failed' | 'cancelled';
  progress: string | null;
  targetColumn: string;
  problemType: string;
  bestModel: string | null;
  metrics: {
    primary_metric?: string;
    leaderboard?: Record<string, Record<string, number>>;
  } | null;
  modelResourceUri?: string | null;
}

const POLL_MS = 2000;
const RUNNING = new Set(['received', 'analyzing', 'training']);
// Rough progress mapping for the bar; precise step counts live server-side.
const STATUS_PCT: Record<JobView['status'], number> = {
  received: 5,
  analyzing: 25,
  training: 65,
  completed: 100,
  failed: 100,
  cancelled: 100
};

const subtitle = document.getElementById('subtitle')!;
const container = document.getElementById('jobs')!;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function metricsLine(job: JobView): string {
  const leaderboard = job.metrics?.leaderboard;
  const primary = job.metrics?.primary_metric;
  if (!leaderboard || !primary || !job.bestModel) return '';
  const winner = leaderboard[job.bestModel]?.[primary];
  const others = Object.entries(leaderboard)
    .filter(([name]) => name !== job.bestModel)
    .map(([name, scores]) => `${name} ${scores[primary]}`)
    .join(' · ');
  return `<div class="meta">🏆 ${escapeHtml(job.bestModel)} ${primary}=${winner}${others ? ` &nbsp;|&nbsp; ${escapeHtml(others)}` : ''}</div>`;
}

function render(jobs: JobView[]): void {
  if (jobs.length === 0) {
    container.innerHTML =
      '<div class="empty">No training jobs yet — upload a dataset and ask the model to train on it.</div>';
    return;
  }
  container.innerHTML = jobs
    .map(job => {
      const pct = STATUS_PCT[job.status] ?? 0;
      const barClass = job.status === 'failed' || job.status === 'cancelled' ? ' bad' : '';
      return `
        <div class="card">
          <div class="row">
            <span class="topic">predict <code>${escapeHtml(job.targetColumn)}</code> <small>(${escapeHtml(job.problemType)})</small></span>
            <span class="status ${job.status}">${job.status}${RUNNING.has(job.status) ? '…' : ''}</span>
          </div>
          <div class="bar${barClass}"><div style="width:${pct}%"></div></div>
          <div class="meta">${escapeHtml(job.progress ?? '')}</div>
          ${metricsLine(job)}
          <div class="meta">job ${job.jobId.slice(0, 8)}…${
            job.status === 'completed' ? ` · model ready: <code>model://${job.jobId}</code>` : ''
          }</div>
        </div>`;
    })
    .join('');
}

const app = new App({ name: 'training-dashboard', version: '0.2.0' });

// The host pushes the training_dashboard tool's own result here right after
// render — that seeds the view before the first poll happens.
app.ontoolresult = result => {
  const data = result.structuredContent as { jobs?: JobView[] } | undefined;
  if (data?.jobs) render(data.jobs);
};

async function poll(): Promise<void> {
  try {
    // Proxied through the host to our MCP server; arrives there as a normal
    // authenticated tools/call.
    const result = await app.callServerTool({ name: 'list_training_jobs', arguments: {} });
    const data = result.structuredContent as { jobs?: JobView[] } | undefined;
    if (data?.jobs) render(data.jobs);
    subtitle.textContent = `Live — refreshes every ${POLL_MS / 1000}s (last: ${new Date().toLocaleTimeString()})`;
  } catch (err) {
    subtitle.textContent = `Polling failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

await app.connect();
subtitle.textContent = 'Connected. Loading…';
await poll();
setInterval(() => void poll(), POLL_MS);
