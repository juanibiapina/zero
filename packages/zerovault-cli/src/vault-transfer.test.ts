import { describe, it, expect } from "vitest";
import { ApiError } from "./client.js";
import {
  exportVault,
  importVault,
  type ExportClient,
  type ImportClient,
  type VaultExport,
} from "./vault-transfer.js";

/**
 * In-memory fake modelling ZeroVault server semantics:
 * - createProject auto-creates default `development`/`production` envs
 * - createProject / createEnvironment throw ApiError(409) on duplicate
 * - putSecrets full-replaces the env's secrets
 */
class FakeVault implements ExportClient, ImportClient {
  private projects = new Map<string, Map<string, { key: string; value: string }[]>>();

  async listProjects() {
    return { projects: [...this.projects.keys()].map((name) => ({ name })) };
  }

  async listEnvironments(project: string) {
    const envs = this.projects.get(project);
    if (!envs) throw new ApiError("Project not found", 404);
    return { environments: [...envs.keys()].map((name) => ({ name })) };
  }

  async getSecrets(project: string, env: string) {
    const secrets = this.projects.get(project)?.get(env);
    if (!secrets) throw new ApiError("Environment not found", 404);
    return { secrets: secrets.map((s) => ({ ...s })) };
  }

  async createProject(name: string) {
    if (this.projects.has(name)) throw new ApiError("Project exists", 409);
    this.projects.set(name, new Map([["development", []], ["production", []]]));
    return {};
  }

  async createEnvironment(project: string, name: string) {
    const envs = this.projects.get(project);
    if (!envs) throw new ApiError("Project not found", 404);
    if (envs.has(name)) throw new ApiError("Environment exists", 409);
    envs.set(name, []);
    return {};
  }

  async putSecrets(project: string, env: string, secrets: { key: string; value: string }[]) {
    const envs = this.projects.get(project);
    if (!envs) throw new ApiError("Project not found", 404);
    envs.set(env, secrets.map((s) => ({ ...s })));
    return {};
  }
}

describe("exportVault / importVault round-trip", () => {
  it("round-trips a populated vault to an equal document", async () => {
    const source = new FakeVault();
    await source.createProject("alpha");
    await source.createEnvironment("alpha", "staging");
    await source.putSecrets("alpha", "development", [
      { key: "API_KEY", value: "abc=123" },
      { key: "EMPTY", value: "" },
      { key: "UNICODE", value: "héllo 🌍" },
    ]);
    await source.putSecrets("alpha", "staging", [{ key: "STAGE", value: "on" }]);
    await source.createProject("beta");
    await source.putSecrets("beta", "production", [{ key: "TOKEN", value: "xyz" }]);

    const first = await exportVault(source);

    const dest = new FakeVault();
    await importVault(dest, first);
    const second = await exportVault(dest);

    expect(second).toEqual(first);
  });

  it("swallows 409 for auto-created default envs and lands their secrets", async () => {
    const doc: VaultExport = {
      version: 1,
      projects: [
        {
          name: "alpha",
          environments: [
            { name: "development", secrets: [{ key: "A", value: "1" }] },
            { name: "production", secrets: [{ key: "B", value: "2" }] },
          ],
        },
      ],
    };

    const dest = new FakeVault();
    await importVault(dest, doc);

    expect(await exportVault(dest)).toEqual(doc);
  });

  it("creates a non-default env and lands its secrets", async () => {
    const doc: VaultExport = {
      version: 1,
      projects: [
        {
          name: "alpha",
          environments: [
            { name: "development", secrets: [] },
            { name: "production", secrets: [] },
            { name: "staging", secrets: [{ key: "S", value: "v" }] },
          ],
        },
      ],
    };

    const dest = new FakeVault();
    await importVault(dest, doc);

    const out = await exportVault(dest);
    const staging = out.projects[0].environments.find((e) => e.name === "staging");
    expect(staging?.secrets).toEqual([{ key: "S", value: "v" }]);
  });

  it("is idempotent — re-importing converges to the same state", async () => {
    const doc: VaultExport = {
      version: 1,
      projects: [
        {
          name: "alpha",
          environments: [{ name: "development", secrets: [{ key: "A", value: "1" }] }],
        },
      ],
    };

    const dest = new FakeVault();
    await importVault(dest, doc);
    await importVault(dest, doc);

    const out = await exportVault(dest);
    const dev = out.projects[0].environments.find((e) => e.name === "development");
    expect(dev?.secrets).toEqual([{ key: "A", value: "1" }]);
  });

  it("produces deterministic sorted output regardless of source order", async () => {
    const source = new FakeVault();
    await source.createProject("zeta");
    await source.createProject("alpha");
    await source.putSecrets("zeta", "development", [
      { key: "Z", value: "z" },
      { key: "A", value: "a" },
    ]);

    const out = await exportVault(source);

    expect(out.projects.map((p) => p.name)).toEqual(["alpha", "zeta"]);
    const zeta = out.projects.find((p) => p.name === "zeta");
    expect(zeta?.environments.map((e) => e.name)).toEqual(["development", "production"]);
    const dev = zeta?.environments.find((e) => e.name === "development");
    expect(dev?.secrets.map((s) => s.key)).toEqual(["A", "Z"]);
  });

  it("throws on an unsupported version", async () => {
    const bad = { version: 2, projects: [] } as unknown as VaultExport;
    await expect(importVault(new FakeVault(), bad)).rejects.toThrow(/version/i);
  });

  it("aborts the import on a non-409 error", async () => {
    const doc: VaultExport = {
      version: 1,
      projects: [
        {
          name: "alpha",
          environments: [{ name: "development", secrets: [{ key: "A", value: "1" }] }],
        },
      ],
    };

    const failing: ImportClient = {
      async createProject() {
        return {};
      },
      async createEnvironment() {
        return {};
      },
      async putSecrets() {
        throw new ApiError("boom", 500);
      },
    };

    await expect(importVault(failing, doc)).rejects.toMatchObject({ status: 500 });
  });
});

describe("ApiError", () => {
  it("carries the HTTP status", () => {
    const err = new ApiError("nope", 409);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(409);
  });
});
