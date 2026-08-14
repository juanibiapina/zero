import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  saveConfig,
  resolveContextForDir,
  addContext,
  removeContext,
  bindContext,
  unbindContext,
  resolveAuth,
  DEFAULT_BASE_URL,
} from "./config.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zv-config-"));
  process.env.ZERO_CONFIG = path.join(dir, "config.json");
});

afterEach(() => {
  delete process.env.ZERO_CONFIG;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig / saveConfig", () => {
  it("returns an empty config when the file does not exist", () => {
    expect(loadConfig()).toEqual({ contexts: {} });
  });

  it("round-trips add → bind → load reflecting state", () => {
    let config = loadConfig();
    config = addContext(config, "work", { apiKey: "zv_work", baseUrl: "https://work" });
    config = addContext(config, "personal", { apiKey: "zv_personal" });
    config = bindContext(config, "/projects/app", "work");
    saveConfig(config);

    const loaded = loadConfig();
    expect(loaded.contexts.work).toEqual({ apiKey: "zv_work", baseUrl: "https://work" });
    expect(loaded.contexts.personal).toEqual({ apiKey: "zv_personal" });
    expect(loaded.dirContexts).toEqual({ "/projects/app": "work" });
  });

  it("writes the file with mode 0600", () => {
    saveConfig(addContext(loadConfig(), "work", { apiKey: "zv_work" }));
    const mode = fs.statSync(process.env.ZERO_CONFIG!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("throws a clear error on malformed JSON", () => {
    fs.writeFileSync(process.env.ZERO_CONFIG!, "{ not json");
    expect(() => loadConfig()).toThrow(/malformed config/i);
  });
});

describe("context mutations", () => {
  it("addContext does not set any global current", () => {
    const config = addContext(loadConfig(), "work", { apiKey: "zv_work" });
    expect(config.dirContexts).toBeUndefined();
  });

  it("bindContext errors on a missing context", () => {
    expect(() => bindContext(loadConfig(), "/projects/app", "nope")).toThrow(
      /no such context/i,
    );
  });

  it("bindContext binds a directory to a context", () => {
    let config = addContext(loadConfig(), "work", { apiKey: "zv_work" });
    config = bindContext(config, "/projects/app", "work");
    expect(config.dirContexts).toEqual({ "/projects/app": "work" });
  });

  it("unbindContext removes a directory binding and reports it", () => {
    let config = addContext(loadConfig(), "work", { apiKey: "zv_work" });
    config = bindContext(config, "/projects/app", "work");
    expect(unbindContext(config, "/projects/app")).toBe(true);
    expect(config.dirContexts).toEqual({});
    expect(unbindContext(config, "/projects/app")).toBe(false);
  });

  it("removeContext prunes directory bindings that reference it", () => {
    let config = addContext(loadConfig(), "work", { apiKey: "zv_work" });
    config = bindContext(config, "/projects/app", "work");
    config = bindContext(config, "/projects/other", "work");
    config = removeContext(config, "work");
    expect(config.contexts.work).toBeUndefined();
    expect(config.dirContexts).toEqual({});
  });
});

describe("resolveContextForDir", () => {
  it("returns null when no ancestor is bound", () => {
    const config = addContext(loadConfig(), "work", { apiKey: "zv_work" });
    expect(resolveContextForDir(config, "/projects/app")).toBeNull();
  });

  it("returns the context bound to the exact directory", () => {
    let config = addContext(loadConfig(), "work", { apiKey: "zv_work" });
    config = bindContext(config, "/projects/app", "work");
    expect(resolveContextForDir(config, "/projects/app")).toEqual({ apiKey: "zv_work" });
  });

  it("walks up to a parent-directory binding", () => {
    let config = addContext(loadConfig(), "work", { apiKey: "zv_work" });
    config = bindContext(config, "/projects/app", "work");
    expect(resolveContextForDir(config, "/projects/app/sub/dir")).toEqual({
      apiKey: "zv_work",
    });
  });

  it("nearest binding wins over an ancestor binding", () => {
    let config = addContext(loadConfig(), "root", { apiKey: "root_key" });
    config = addContext(config, "inner", { apiKey: "inner_key" });
    config = bindContext(config, "/projects", "root");
    config = bindContext(config, "/projects/app", "inner");
    expect(resolveContextForDir(config, "/projects/app/sub")).toEqual({
      apiKey: "inner_key",
    });
  });

  it("returns null when the binding points at a removed context", () => {
    let config = addContext(loadConfig(), "work", { apiKey: "zv_work" });
    config = bindContext(config, "/projects/app", "work");
    delete config.contexts.work;
    expect(resolveContextForDir(config, "/projects/app")).toBeNull();
  });
});

describe("resolveAuth precedence", () => {
  const context = { apiKey: "ctx_key", baseUrl: "https://ctx" };
  const DEFAULT = "https://default";

  it("flag wins over env and context", () => {
    const auth = resolveAuth({
      flags: { apiKey: "flag_key", baseUrl: "https://flag" },
      env: { apiKey: "env_key", apiUrl: "https://env" },
      context,
      defaultBaseUrl: DEFAULT,
    });
    expect(auth).toEqual({ apiKey: "flag_key", baseUrl: "https://flag", via: "api_key" });
  });

  it("context wins over env", () => {
    const auth = resolveAuth({
      flags: {},
      env: { apiKey: "env_key", apiUrl: "https://env" },
      context,
      defaultBaseUrl: DEFAULT,
    });
    expect(auth).toEqual({ apiKey: "ctx_key", baseUrl: "https://ctx", via: "api_key" });
  });

  it("falls back to env when no context is set", () => {
    const auth = resolveAuth({
      flags: {},
      env: { apiKey: "env_key", apiUrl: "https://env" },
      context: null,
      defaultBaseUrl: DEFAULT,
    });
    expect(auth).toEqual({ apiKey: "env_key", baseUrl: "https://env", via: "api_key" });
  });

  it("uses context when neither flag nor env is set", () => {
    const auth = resolveAuth({ flags: {}, env: {}, context, defaultBaseUrl: DEFAULT });
    expect(auth).toEqual({ apiKey: "ctx_key", baseUrl: "https://ctx", via: "api_key" });
  });

  it("falls back to the default base url when no source supplies one", () => {
    const auth = resolveAuth({
      flags: {},
      env: { apiKey: "env_key" },
      context: null,
      defaultBaseUrl: DEFAULT,
    });
    expect(auth).toEqual({ apiKey: "env_key", baseUrl: DEFAULT, via: "api_key" });
  });

  it("returns null when no source supplies an api key", () => {
    expect(resolveAuth({ flags: {}, env: {}, context: null, defaultBaseUrl: DEFAULT })).toBeNull();
  });

  it("defaults to the product-neutral API origin when nothing overrides it", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.zeroapps.dev");
    const auth = resolveAuth({
      flags: {},
      env: { apiKey: "env_key" },
      context: null,
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(auth).toEqual({ apiKey: "env_key", baseUrl: "https://api.zeroapps.dev", via: "api_key" });
  });

  it("passes a /vault-suffixed base URL through verbatim", () => {
    // The CLI deliberately does not rewrite base URLs: a `zv`-era
    // `https://api.zeroapps.dev/vault` is a user error that shows up as 404s,
    // not something to paper over.
    const auth = resolveAuth({
      flags: {},
      env: { apiKey: "env_key", apiUrl: "https://api.zeroapps.dev/vault" },
      context: null,
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(auth?.baseUrl).toBe("https://api.zeroapps.dev/vault");
  });
});

describe("resolveAuth with a stored login", () => {
  const DEFAULT = "https://default";
  const stored = {
    accessToken: "at_stored",
    refreshToken: "rt_stored",
    expiresAt: Date.now() + 3_600_000,
    userId: "user_1",
    orgId: "org_1",
    email: "dev@example.com",
    issuer: "https://clerk.example.dev",
    clientId: "client_1",
  };

  it("uses the login for the resolved base url when nothing more explicit is set", () => {
    const auth = resolveAuth({
      flags: {},
      env: {},
      context: null,
      logins: { [DEFAULT]: stored },
      defaultBaseUrl: DEFAULT,
    });

    expect(auth).toEqual({ apiKey: "at_stored", baseUrl: DEFAULT, via: "login", login: stored });
  });

  it("lets an explicit env key win, since a login is ambient machine state", () => {
    const auth = resolveAuth({
      flags: {},
      env: { apiKey: "env_key" },
      context: null,
      logins: { [DEFAULT]: stored },
      defaultBaseUrl: DEFAULT,
    });

    expect(auth).toMatchObject({ apiKey: "env_key", via: "api_key" });
  });

  it("ignores a login stored for a different origin", () => {
    const auth = resolveAuth({
      flags: {},
      env: {},
      context: null,
      logins: { "https://other": stored },
      defaultBaseUrl: DEFAULT,
    });

    expect(auth).toBeNull();
  });

  it("follows --base-url to the login for that origin", () => {
    const auth = resolveAuth({
      flags: { baseUrl: "https://other" },
      env: {},
      context: null,
      logins: { "https://other": stored, [DEFAULT]: { ...stored, accessToken: "at_default" } },
      defaultBaseUrl: DEFAULT,
    });

    expect(auth).toMatchObject({ apiKey: "at_stored", baseUrl: "https://other" });
  });
});
