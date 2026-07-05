/**
 * Server configuration, loaded from environment variables.
 *
 * The design mirrors how you would configure a Microsoft Entra ID protected
 * API, translated to Google:
 *
 *   Entra ID concept                      Google equivalent (used here)
 *   ------------------------------------  ---------------------------------------------
 *   Tenant / authority URL                Fixed issuer: https://accounts.google.com
 *   Application (client) ID as audience   GOOGLE_AUDIENCE (aud claim your callers use)
 *   Tenant restriction                    GOOGLE_ALLOWED_DOMAIN (the `hd` claim)
 *   App role / user assignment            GOOGLE_ALLOWED_EMAILS allowlist
 */

export interface ServerConfig {
  /** TCP port the HTTP server listens on. */
  port: number;
  /**
   * Public base URL of this server (no trailing slash). Used to build the
   * RFC 9728 protected-resource metadata document and WWW-Authenticate hints.
   */
  publicUrl: string;
  /**
   * Required `aud` claim of incoming Google ID tokens. Callers mint tokens
   * with this audience, e.g.:
   *   gcloud auth print-identity-token \
   *     --impersonate-service-account=SA_EMAIL \
   *     --audiences="$GOOGLE_AUDIENCE"
   */
  audience: string;
  /** Optional Google Workspace domain restriction (`hd` claim), like an Entra tenant filter. */
  allowedDomain?: string;
  /** Optional allowlist of exact account emails (user or service-account). */
  allowedEmails?: string[];
  /**
   * Postgres connection string. Unset → embedded PGlite under {dataDir}/db,
   * which is a real Postgres engine in-process (fine for learning; use a
   * managed Postgres in production).
   */
  databaseUrl?: string;
  /** Root directory for datasets, job configs, model artifacts and the embedded DB. */
  dataDir: string;
  /** Python interpreter with scikit-learn/xgboost installed (see python/requirements.txt). */
  pythonBin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const audience = env.GOOGLE_AUDIENCE;
  if (!audience) {
    throw new Error(
      'GOOGLE_AUDIENCE is required. Set it to the audience (aud claim) your callers ' +
        'mint Google ID tokens for — typically the public URL of this server or an ' +
        'OAuth client ID. There is deliberately no unauthenticated fallback.'
    );
  }

  const port = Number(env.PORT ?? 3000);
  return {
    port,
    publicUrl: (env.MCP_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    audience,
    allowedDomain: env.GOOGLE_ALLOWED_DOMAIN || undefined,
    allowedEmails: env.GOOGLE_ALLOWED_EMAILS
      ? env.GOOGLE_ALLOWED_EMAILS.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
      : undefined,
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: env.DATA_DIR ?? 'var',
    pythonBin: env.PYTHON_BIN ?? 'python3'
  };
}
