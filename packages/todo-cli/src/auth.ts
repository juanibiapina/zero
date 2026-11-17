import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import * as oidc from "openid-client";

export const DEFAULT_ISSUER = "https://clerk.zero.juanibiapina.dev";
export const DEFAULT_CLIENT_ID = "QFIeIWDsqBsxOfq5";

const SCOPE = "openid profile email offline_access";
const REFRESH_MARGIN_MS = 60_000;
const LOCK_STALE_MS = 30_000;
const LOGIN_TIMEOUT_MS = 300_000;
export const LOGIN_HINT = "Run `zero-todo auth login` to sign in.";

const DONE_PAGE =
  "<!doctype html><meta charset=utf-8><title>Signed in</title>" +
  "<p>Signed in to Zero. You can close this tab and return to the terminal.";

export type Env = Record<string, string | undefined>;

export type Login = {
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  email: string | null;
};

export class CliError extends Error {
  constructor(message: string, readonly exitCode: 1 | 75 = 1, readonly hint?: string) {
    super(message);
  }
}

export const notSignedIn = () => new CliError("not signed in", 1, LOGIN_HINT);
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function authPaths(env: Env) {
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "zero-todo");
  const file = path.join(dir, "auth.json");
  return { dir, file, lock: `${file}.lock` };
}

async function ensureDir(env: Env) {
  const { dir } = authPaths(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export async function readLogin(env: Env): Promise<Login | null> {
  try {
    return JSON.parse(await readFile(authPaths(env).file, "utf8")) as Login;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeLogin(env: Env, login: Login) {
  await ensureDir(env);
  const { file } = authPaths(env);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(login, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

export async function deleteLogin(env: Env) {
  await rm(authPaths(env).file, { force: true });
}

async function withLock<T>(env: Env, work: () => Promise<T>): Promise<T> {
  await ensureDir(env);
  const { lock } = authPaths(env);
  const deadline = Date.now() + LOCK_STALE_MS + 5_000;
  for (;;) {
    try {
      await (await open(lock, "wx", 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await stat(lock).catch(() => null);
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new CliError("another zero-todo is refreshing the sign-in; try again", 75);
      await sleep(25 + Math.random() * 50);
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

async function discover(issuer: string, clientId: string): Promise<oidc.Configuration> {
  try {
    const insecure = new URL(issuer).protocol === "http:";
    return await oidc.discovery(new URL(issuer), clientId, undefined, oidc.None(),
      insecure ? { execute: [oidc.allowInsecureRequests] } : undefined);
  } catch (error) {
    throw new CliError(`could not reach ${issuer}: ${errorText(error)}`, 75);
  }
}

function tokenError(error: unknown, action: string): CliError {
  if (error instanceof oidc.ResponseBodyError) {
    return new CliError(`${action} failed: ${error.error_description ?? error.error}`, 1, LOGIN_HINT);
  }
  return new CliError(`${action} failed: ${errorText(error)}`, 75);
}

type Tokens = oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;

function toLogin(tokens: Tokens, previous: Pick<Login, "issuer" | "clientId"> & Partial<Login>): Login {
  const claims = tokens.claims();
  const refreshToken = tokens.refresh_token ?? previous.refreshToken;
  if (!refreshToken) throw new CliError("the sign-in returned no refresh token");
  return {
    issuer: previous.issuer,
    clientId: previous.clientId,
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + (tokens.expiresIn() ?? 3600) * 1000,
    userId: claims?.sub ?? previous.userId ?? "",
    email: typeof claims?.email === "string" ? claims.email : previous.email ?? null,
  };
}

const fresh = (login: Login) => login.expiresAt - Date.now() > REFRESH_MARGIN_MS;

async function refresh(login: Login): Promise<Login> {
  const config = await discover(login.issuer, login.clientId);
  try {
    return toLogin(await oidc.refreshTokenGrant(config, login.refreshToken), login);
  } catch (error) {
    throw tokenError(error, "refreshing the sign-in");
  }
}

export async function accessToken(env: Env, options: { rejected?: string } = {}): Promise<string> {
  const stored = await readLogin(env);
  if (!stored) throw notSignedIn();
  if (!options.rejected && fresh(stored)) return stored.accessToken;
  return withLock(env, async () => {
    const current = await readLogin(env);
    if (!current) throw notSignedIn();
    if (current.accessToken !== options.rejected && fresh(current)) return current.accessToken;
    const refreshed = await refresh(current);
    await writeLogin(env, refreshed);
    return refreshed.accessToken;
  });
}

export async function login(env: Env, options: {
  port?: number;
  openBrowser: (url: string) => Promise<void>;
  stderr: (text: string) => void;
}): Promise<Login> {
  const issuer = env.ZERO_TODO_ISSUER ?? DEFAULT_ISSUER;
  const clientId = env.ZERO_TODO_CLIENT_ID ?? DEFAULT_CLIENT_ID;
  const config = await discover(issuer, clientId);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(new CliError(`cannot listen on 127.0.0.1:${options.port ?? 0}: ${errorText(error)}`)));
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  const callback = new Promise<URL>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CliError("sign-in timed out")), LOGIN_TIMEOUT_MS);
    timer.unref();
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      clearTimeout(timer);
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(`Sign-in failed: ${error}`);
        reject(new CliError(`sign-in failed: ${url.searchParams.get("error_description") ?? error}`));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(DONE_PAGE);
      resolve(url);
    });
  });
  callback.catch(() => undefined);

  try {
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
    });
    options.stderr(`Opening ${url.href}\nIf the browser does not open, visit that URL.\n`);
    await options.openBrowser(url.href);
    const current = await callback;
    let tokens: Tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(config, current, { pkceCodeVerifier: verifier, expectedState: state });
    } catch (error) {
      throw tokenError(error, "sign-in");
    }
    const result = toLogin(tokens, { issuer, clientId });
    await writeLogin(env, result);
    return result;
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
