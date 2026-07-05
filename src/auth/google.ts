/**
 * Bearer-token authentication using Google-issued OIDC ID tokens.
 *
 * This is the GCP analog of protecting an API with Microsoft Entra ID:
 *
 *  - Entra: tokens come from https://login.microsoftonline.com/{tenant}/v2.0,
 *    are validated against the tenant's JWKS, and must carry your app's
 *    client ID in `aud`.
 *  - Google: tokens come from https://accounts.google.com, are validated
 *    against Google's JWKS (https://www.googleapis.com/oauth2/v3/certs), and
 *    must carry the audience you configured in `aud`.
 *
 * In both cases the resource server (this MCP server) never talks to the
 * identity provider interactively — it only fetches public signing keys and
 * verifies the JWT signature + claims locally. There is NO api-key or other
 * anonymous path: every request to the MCP endpoint must present a valid
 * `Authorization: Bearer <jwt>` header.
 */
import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/** Google publishes ID-token signing keys here (rotated regularly, so we use a remote JWK set with caching). */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** Google ID tokens historically use both forms of the issuer claim. */
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleAuthOptions {
  /** Required `aud` claim. Tokens minted for any other audience are rejected. */
  audience: string;
  /** Optional Google Workspace domain (`hd` claim) restriction. */
  allowedDomain?: string;
  /** Optional exact-email allowlist (lowercased). */
  allowedEmails?: string[];
  /**
   * Test seam: override the key-resolution function and accepted issuers.
   * The production entrypoint (src/index.ts) never sets these — it always
   * verifies against Google's real JWKS. They exist so the smoke test can
   * sign tokens with an ephemeral local key pair.
   */
  getKey?: JWTVerifyGetKey;
  issuers?: string[];
}

/** Identity extracted from a verified token; attached to the request for downstream tools. */
export interface VerifiedIdentity {
  /** Stable Google subject ID (the `sub` claim). */
  subject: string;
  /** Account email, when present (user tokens and service-account tokens both carry it). */
  email?: string;
  /** Full verified payload for anything else you want to inspect. */
  payload: JWTPayload;
}

export class TokenRejectedError extends Error {
  constructor(
    message: string,
    /** OAuth error code for the WWW-Authenticate header (RFC 6750). */
    readonly oauthError: 'invalid_token' | 'insufficient_scope' = 'invalid_token'
  ) {
    super(message);
    this.name = 'TokenRejectedError';
  }
}

/**
 * Creates a verifier bound to one JWKS + audience. The JWKS client caches
 * keys and re-fetches on rotation, so constructing this once at startup is
 * the right pattern (same as Entra samples that cache the OpenID metadata).
 */
export function createGoogleTokenVerifier(options: GoogleAuthOptions) {
  const getKey = options.getKey ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  const issuers = options.issuers ?? GOOGLE_ISSUERS;

  return async function verifyToken(token: string): Promise<VerifiedIdentity> {
    let payload: JWTPayload;
    try {
      // jose checks signature, `exp`/`nbf`, `iss`, and `aud` in one call.
      ({ payload } = await jwtVerify(token, getKey, {
        issuer: issuers,
        audience: options.audience
      }));
    } catch (err) {
      throw new TokenRejectedError(err instanceof Error ? err.message : 'token verification failed');
    }

    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined;

    // Google sets email_verified=false for unverified addresses; treat those
    // as untrusted the same way Entra treats unverified UPNs.
    if (email && payload.email_verified === false) {
      throw new TokenRejectedError('email in token is not verified');
    }

    if (options.allowedDomain) {
      // `hd` is only present for Google Workspace accounts. Fall back to the
      // email suffix so service accounts (which have no `hd`) can qualify.
      const hd = typeof payload.hd === 'string' ? payload.hd : undefined;
      const domainOk =
        hd === options.allowedDomain || (email?.endsWith(`@${options.allowedDomain}`) ?? false);
      if (!domainOk) {
        throw new TokenRejectedError(`account is not in domain ${options.allowedDomain}`, 'insufficient_scope');
      }
    }

    if (options.allowedEmails && (!email || !options.allowedEmails.includes(email))) {
      throw new TokenRejectedError('account is not on the allowlist', 'insufficient_scope');
    }

    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new TokenRejectedError('token has no subject');
    }

    return { subject: payload.sub, email, payload };
  };
}

/**
 * Express middleware enforcing bearer auth on the MCP endpoint.
 *
 * On failure it answers 401/403 with a WWW-Authenticate header pointing at
 * our RFC 9728 protected-resource metadata, which is how spec-compliant MCP
 * clients discover *where* to get a token. On success it attaches the
 * verified identity to `req.auth` in the shape the MCP SDK's Streamable HTTP
 * transport forwards to tool handlers (`extra.authInfo`).
 */
export function createGoogleAuthMiddleware(options: GoogleAuthOptions & { resourceMetadataUrl: string }) {
  const verify = createGoogleTokenVerifier(options);

  return async function googleAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const challenge = (error?: string, description?: string) => {
      const parts = [`resource_metadata="${options.resourceMetadataUrl}"`];
      if (error) parts.unshift(`error="${error}"`, `error_description="${description ?? ''}"`);
      return `Bearer ${parts.join(', ')}`;
    };

    const header = req.headers.authorization;
    if (!header?.toLowerCase().startsWith('bearer ')) {
      res
        .status(401)
        .set('WWW-Authenticate', challenge())
        .json({ error: 'unauthorized', error_description: 'Missing bearer token' });
      return;
    }

    try {
      const identity = await verify(header.slice('bearer '.length).trim());

      // AuthInfo shape consumed by StreamableHTTPServerTransport: it copies
      // req.auth into every request handler's `extra.authInfo`.
      (req as Request & { auth?: unknown }).auth = {
        token: header.slice('bearer '.length).trim(),
        clientId: identity.subject,
        scopes: [],
        extra: { email: identity.email, subject: identity.subject }
      };
      next();
    } catch (err) {
      const rejected = err instanceof TokenRejectedError ? err : new TokenRejectedError('invalid token');
      const status = rejected.oauthError === 'insufficient_scope' ? 403 : 401;
      res
        .status(status)
        .set('WWW-Authenticate', challenge(rejected.oauthError, rejected.message))
        .json({ error: rejected.oauthError, error_description: rejected.message });
    }
  };
}

/**
 * RFC 9728 OAuth Protected Resource Metadata document.
 *
 * MCP's authorization spec says: when a client gets a 401, it should follow
 * the `resource_metadata` URL from WWW-Authenticate to learn which
 * authorization server protects this resource. For Entra that document would
 * point at login.microsoftonline.com; here it points at Google.
 *
 * Note: Google does not support RFC 7591 dynamic client registration, so
 * fully-automatic client onboarding won't happen — callers obtain tokens
 * out-of-band (gcloud, service-account impersonation, or a pre-registered
 * OAuth client). That is the same operational model as most Entra-protected
 * APIs, where the app registration exists before any client connects.
 */
export function protectedResourceMetadata(publicUrl: string) {
  return {
    resource: `${publicUrl}/mcp`,
    authorization_servers: ['https://accounts.google.com'],
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid', 'email'],
    resource_documentation: `${publicUrl}/`
  };
}
