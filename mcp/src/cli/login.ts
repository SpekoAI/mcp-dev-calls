/**
 * Browser login for `speko login` (and the default path of the init wizard).
 *
 * Runs a standard OAuth 2.1 authorization-code + PKCE flow against Speko's
 * authorization server (the platform better-auth oauth-provider), then fetches
 * the caller's organization MCP key from api.speko.dev and returns it — so the
 * user never copies or pastes a key.
 *
 * Design note: we exchange the browser login for the org's long-lived `sk_` key
 * and hand THAT to the MCP. The OAuth access token is used once (to read the key)
 * and discarded. So nothing downstream changes — the MCP authenticates with
 * SPEKO_API_KEY exactly as before — and there's no token-refresh to maintain.
 *
 * Zero runtime deps: node:http (loopback redirect), node:crypto (PKCE/state), fetch.
 */
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { AddressInfo } from "node:net";

const API_BASE = (process.env.SPEKOAI_API_URL || "https://api.speko.dev").replace(/\/+$/, "");
/** OAuth discovery doc for the platform better-auth provider (the JWT issuer). */
const AUTH_DISCOVERY =
  process.env.SPEKO_OAUTH_DISCOVERY ||
  "https://platform.speko.dev/.well-known/oauth-authorization-server/api/auth";

const LOGIN_TIMEOUT_MS = 5 * 60_000;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

function resultPage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:30rem;margin:18vh auto;text-align:center;color:#111">
<div style="font-size:2.5rem">📞</div>
<h1 style="font-size:1.35rem;margin:.5rem 0">${escapeHtml(title)}</h1>
<p style="color:#555;line-height:1.5">${escapeHtml(body)}</p></body>`;
}

function openBrowser(url: string): void {
  if (["1", "true", "yes"].includes((process.env.SPEKO_NO_BROWSER ?? "").toLowerCase())) return;
  try {
    const p = platform();
    const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
    const args = p === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the URL is printed for manual paste */
  }
}

async function discover(): Promise<Discovery> {
  const r = await fetch(AUTH_DISCOVERY, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`OAuth discovery failed (HTTP ${r.status}) at ${AUTH_DISCOVERY}`);
  const d = (await r.json()) as Partial<Discovery>;
  if (!d.authorization_endpoint || !d.token_endpoint || !d.registration_endpoint || !d.issuer) {
    throw new Error("OAuth discovery doc is missing required endpoints");
  }
  return d as Discovery;
}

/** Dynamic client registration (RFC 7591) — a public, native, loopback client. */
async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<string> {
  const r = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Speko Calls CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      type: "native",
      scope: "openid profile email",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`client registration failed (HTTP ${r.status})`);
  const j = (await r.json()) as { client_id?: string };
  if (!j.client_id) throw new Error("client registration returned no client_id");
  return j.client_id;
}

/** Fetch the org's idempotent MCP key from api.speko.dev using a bearer JWT. */
async function fetchOrgKey(bearer: string): Promise<string> {
  const r = await fetch(`${API_BASE}/v1/api-keys/organization-credentials`, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 403) {
    throw new Error("your account has no organization yet — finish signup at platform.speko.dev, then retry");
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`couldn't fetch your API key (HTTP ${r.status})${body ? `: ${body.slice(0, 160)}` : ""}`);
  }
  const j = (await r.json()) as { mcpApiKey?: { key?: string } };
  const key = j.mcpApiKey?.key;
  if (!key) throw new Error("API-key response was missing mcpApiKey.key");
  return key;
}

interface Loopback {
  server: Server;
  redirectUri: string;
  waitForCode: Promise<string>;
}

/** Bind an ephemeral loopback listener first, so the redirect_uri (with its port) is exact. */
function startLoopback(expectedState: string): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const waitForCode = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    const timeout = setTimeout(
      () => rejectCode(new Error("login timed out (5 min) — no redirect received")),
      LOGIN_TIMEOUT_MS,
    );
    if (typeof timeout.unref === "function") timeout.unref();

    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const send = (status: number, title: string, body: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(resultPage(title, body));
      };
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      clearTimeout(timeout);
      if (err) {
        send(400, "Sign-in failed", `Authorization was denied (${err}). You can close this tab and try again.`);
        rejectCode(new Error(`authorization denied: ${err}`));
        return;
      }
      if (!code || state !== expectedState) {
        send(400, "Sign-in failed", "The response was invalid or didn't match. Close this tab and re-run the login.");
        rejectCode(new Error("state mismatch or missing authorization code"));
        return;
      }
      send(200, "You're connected ✓", "Speko Calls is signed in. You can close this tab and return to your terminal.");
      resolveCode(code);
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, redirectUri: `http://127.0.0.1:${port}/callback`, waitForCode });
    });
  });
}

/**
 * Run the full browser login and return the org's `sk_` API key.
 * `log` receives human-readable progress lines; throws with a clear message on failure.
 */
export async function browserLogin(log: (msg: string) => void = () => {}): Promise<string> {
  const disc = await discover();

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const { server, redirectUri, waitForCode } = await startLoopback(state);
  try {
    const clientId = await registerClient(disc.registration_endpoint, redirectUri);

    const authUrl = new URL(disc.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "openid profile email");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    log("Opening your browser to sign in to Speko…");
    log(`If it doesn't open, paste this URL into your browser:\n    ${authUrl.toString()}`);
    openBrowser(authUrl.toString());
    log("Waiting for you to finish signing in…");

    const code = await waitForCode;

    // NB: we deliberately do NOT send an RFC 8707 `resource`. With one, better-auth
    // validates it against a deployment-specific allow-list (validAudiences, set in
    // the server's env — not knowable client-side); a value not on the list is a hard
    // 400 "requested resource invalid" that also burns the auth code. Without it the
    // token request always succeeds. We then authenticate with the `id_token`, which —
    // because we request `openid` scope — is unconditionally a JWT signed by this
    // issuer. api.speko.dev verifies issuer + sub and ignores audience/token-type, so
    // the id_token is accepted for the org-key fetch. (The access token is opaque
    // without `resource`, so it's only a last-ditch fallback.)
    const tok = await fetch(disc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!tok.ok) {
      const body = await tok.text().catch(() => "");
      throw new Error(`token exchange failed (HTTP ${tok.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const tj = (await tok.json()) as { access_token?: string; id_token?: string };
    const bearer = tj.id_token ?? tj.access_token;
    if (!bearer) throw new Error("token endpoint returned neither an id_token nor an access_token");
    return await fetchOrgKey(bearer);
  } finally {
    server.close();
  }
}
