/**
 * Postgres persistence for the commerce + training pipeline.
 *
 * Two interchangeable backends behind one tiny `query()` seam:
 *   - No DATABASE_URL  → PGlite, a real Postgres engine embedded in-process
 *     (file-backed under var/db). Zero setup, ideal for learning and tests.
 *   - DATABASE_URL set → the standard `pg` Pool against a real server
 *     (Cloud SQL, RDS, docker…). Same SQL, same code paths.
 *
 * Tables tell the story of the product flow:
 *   customers      — who (keyed by the Google `sub` claim from the bearer token)
 *   transactions   — every purchase, with provider receipt id and status
 *   entitlements   — what a completed purchase unlocks (tier, expiry)
 *   datasets       — uploaded CSVs (bytes on disk, metadata here)
 *   training_jobs  — one row per training run; status marches
 *                    received → analyzing → training → completed/failed/cancelled
 *   audit_events   — append-only log of everything above
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface QueryResultLike<T> {
  rows: T[];
}

export interface SqlBackend {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResultLike<T>>;
  /** Multi-statement execution (DDL); prepared-statement APIs only allow one command. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  subject     TEXT PRIMARY KEY,
  email       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,
  customer_subject TEXT NOT NULL REFERENCES customers(subject),
  product_id       TEXT NOT NULL,
  amount_usd       NUMERIC NOT NULL,
  status           TEXT NOT NULL,          -- succeeded | declined
  receipt_id       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entitlements (
  id               TEXT PRIMARY KEY,
  transaction_id   TEXT NOT NULL REFERENCES transactions(id),
  customer_subject TEXT NOT NULL REFERENCES customers(subject),
  product_id       TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS datasets (
  id               TEXT PRIMARY KEY,
  customer_subject TEXT NOT NULL REFERENCES customers(subject),
  name             TEXT NOT NULL,
  path             TEXT NOT NULL,
  bytes            BIGINT NOT NULL,
  columns          JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS training_jobs (
  id               TEXT PRIMARY KEY,       -- doubles as the MCP task id
  customer_subject TEXT NOT NULL REFERENCES customers(subject),
  entitlement_id   TEXT NOT NULL REFERENCES entitlements(id),
  dataset_id       TEXT NOT NULL REFERENCES datasets(id),
  target_column    TEXT NOT NULL,
  problem_type     TEXT NOT NULL,          -- classification | regression | auto
  resolved_type    TEXT,                   -- what the analyzer decided when auto
  status           TEXT NOT NULL,
  progress_message TEXT,
  best_model       TEXT,
  metrics          JSONB,
  model_path       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS audit_events (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_subject TEXT,
  kind             TEXT NOT NULL,
  details          JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export interface TransactionRow {
  id: string;
  customer_subject: string;
  product_id: string;
  amount_usd: string;
  status: string;
  receipt_id: string;
}

export interface EntitlementRow {
  id: string;
  transaction_id: string;
  customer_subject: string;
  product_id: string;
  expires_at: string | Date;
}

export interface DatasetRow {
  id: string;
  customer_subject: string;
  name: string;
  path: string;
  bytes: string | number;
  columns: string[] | null;
}

export interface TrainingJobRow {
  id: string;
  customer_subject: string;
  entitlement_id: string;
  dataset_id: string;
  target_column: string;
  problem_type: string;
  resolved_type: string | null;
  status: string;
  progress_message: string | null;
  best_model: string | null;
  metrics: Record<string, unknown> | null;
  model_path: string | null;
  created_at: string | Date;
  finished_at: string | Date | null;
}

export class Db {
  constructor(private readonly backend: SqlBackend) {}

  static async open(databaseUrl?: string, pgliteDir?: string): Promise<Db> {
    let backend: SqlBackend;
    if (databaseUrl) {
      const pool = new pg.Pool({ connectionString: databaseUrl });
      backend = {
        query: async <T>(sql: string, params?: unknown[]) =>
          (await pool.query(sql, params)) as unknown as QueryResultLike<T>,
        exec: async sql => {
          await pool.query(sql);
        },
        close: () => pool.end()
      };
    } else {
      const lite = new PGlite(pgliteDir); // undefined → in-memory (used by the smoke test)
      backend = {
        query: async (sql, params) => (await lite.query(sql, params)) as QueryResultLike<never>,
        exec: async sql => {
          await lite.exec(sql);
        },
        close: () => lite.close()
      };
    }
    const db = new Db(backend);
    await backend.exec(SCHEMA);
    return db;
  }

  close(): Promise<void> {
    return this.backend.close();
  }

  // --- customers & audit -----------------------------------------------------

  async upsertCustomer(subject: string, email?: string): Promise<void> {
    await this.backend.query(
      `INSERT INTO customers (subject, email) VALUES ($1, $2)
       ON CONFLICT (subject) DO UPDATE SET email = COALESCE(EXCLUDED.email, customers.email)`,
      [subject, email ?? null]
    );
  }

  async logEvent(subject: string | null, kind: string, details: Record<string, unknown>): Promise<void> {
    await this.backend.query(`INSERT INTO audit_events (customer_subject, kind, details) VALUES ($1, $2, $3)`, [
      subject,
      kind,
      JSON.stringify(details)
    ]);
  }

  // --- purchases ---------------------------------------------------------------

  async recordPurchase(row: {
    transactionId: string;
    entitlementId: string;
    subject: string;
    productId: string;
    amountUsd: number;
    receiptId: string;
    status: 'succeeded' | 'declined';
    expiresAt: Date;
  }): Promise<void> {
    await this.backend.query(
      `INSERT INTO transactions (id, customer_subject, product_id, amount_usd, status, receipt_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.transactionId, row.subject, row.productId, row.amountUsd, row.status, row.receiptId]
    );
    if (row.status === 'succeeded') {
      await this.backend.query(
        `INSERT INTO entitlements (id, transaction_id, customer_subject, product_id, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.entitlementId, row.transactionId, row.subject, row.productId, row.expiresAt.toISOString()]
      );
    }
  }

  /** Active (unexpired) entitlements for a customer, newest first. */
  async activeEntitlements(subject: string): Promise<EntitlementRow[]> {
    const res = await this.backend.query<EntitlementRow>(
      `SELECT * FROM entitlements WHERE customer_subject = $1 AND expires_at > now() ORDER BY created_at DESC`,
      [subject]
    );
    return res.rows;
  }

  // --- datasets ------------------------------------------------------------------

  async createDataset(row: {
    id: string;
    subject: string;
    name: string;
    path: string;
    bytes: number;
    columns: string[];
  }): Promise<void> {
    await this.backend.query(
      `INSERT INTO datasets (id, customer_subject, name, path, bytes, columns) VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.subject, row.name, row.path, row.bytes, JSON.stringify(row.columns)]
    );
  }

  async getDataset(id: string, subject: string): Promise<DatasetRow | undefined> {
    const res = await this.backend.query<DatasetRow>(
      `SELECT * FROM datasets WHERE id = $1 AND customer_subject = $2`,
      [id, subject]
    );
    return res.rows[0];
  }

  // --- training jobs ---------------------------------------------------------------

  async createJob(row: {
    id: string;
    subject: string;
    entitlementId: string;
    datasetId: string;
    targetColumn: string;
    problemType: string;
  }): Promise<void> {
    await this.backend.query(
      `INSERT INTO training_jobs (id, customer_subject, entitlement_id, dataset_id, target_column, problem_type, status, progress_message)
       VALUES ($1, $2, $3, $4, $5, $6, 'received', 'Queued')`,
      [row.id, row.subject, row.entitlementId, row.datasetId, row.targetColumn, row.problemType]
    );
  }

  async updateJobProgress(id: string, status: string, message: string): Promise<void> {
    await this.backend.query(`UPDATE training_jobs SET status = $2, progress_message = $3 WHERE id = $1`, [
      id,
      status,
      message
    ]);
  }

  async completeJob(row: {
    id: string;
    resolvedType: string;
    bestModel: string;
    metrics: Record<string, unknown>;
    modelPath: string;
  }): Promise<void> {
    await this.backend.query(
      `UPDATE training_jobs
       SET status = 'completed', progress_message = 'Model ready for download',
           resolved_type = $2, best_model = $3, metrics = $4, model_path = $5, finished_at = now()
       WHERE id = $1`,
      [row.id, row.resolvedType, row.bestModel, JSON.stringify(row.metrics), row.modelPath]
    );
  }

  async failJob(id: string, status: 'failed' | 'cancelled', message: string): Promise<void> {
    await this.backend.query(
      `UPDATE training_jobs SET status = $2, progress_message = $3, finished_at = now() WHERE id = $1`,
      [id, status, message]
    );
  }

  async getJob(id: string, subject: string): Promise<TrainingJobRow | undefined> {
    const res = await this.backend.query<TrainingJobRow>(
      `SELECT * FROM training_jobs WHERE id = $1 AND customer_subject = $2`,
      [id, subject]
    );
    return res.rows[0];
  }

  async listJobs(subject: string): Promise<TrainingJobRow[]> {
    const res = await this.backend.query<TrainingJobRow>(
      `SELECT * FROM training_jobs WHERE customer_subject = $1 ORDER BY created_at DESC LIMIT 50`,
      [subject]
    );
    return res.rows;
  }

  /** Quota inputs: runs charged against an entitlement today (UTC) and overall. */
  async jobCounts(entitlementId: string): Promise<{ today: number; total: number }> {
    const res = await this.backend.query<{ today: string; total: string }>(
      `SELECT
         count(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS today,
         count(*) AS total
       FROM training_jobs
       WHERE entitlement_id = $1 AND status <> 'cancelled'`,
      [entitlementId]
    );
    return { today: Number(res.rows[0].today), total: Number(res.rows[0].total) };
  }
}
