import { accessToken, CliError, LOGIN_HINT, type Env } from "./auth";

export const DEFAULT_API_URL = "https://zero.juanibiapina.dev";

export type Recurrence = Record<string, unknown>;

export type Task = {
  id: string;
  text: string;
  showUpDate: string | null;
  recurrence: Recurrence | null;
  recurrenceDate: string | null;
  parent: null | { kind: "project"; projectId: string } | { kind: "medicine"; medicineId: string; role: "restock" | null };
  recordingId: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ProjectState = "in-play" | "backlog" | "done";

export type Project = {
  id: string;
  title: string;
  icon: string;
  description: string | null;
  state: ProjectState;
  attention?: "active" | "next" | "waiting" | "after" | "backlog" | "done";
  createdAt: string;
};

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export class Api {
  constructor(private readonly baseUrl: string, private readonly env: Env) {}

  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const override = this.env.ZERO_TODO_TOKEN;
    let token = override ?? await accessToken(this.env);
    let response = await this.send(method, path, body, token);
    if (response.status === 401 && !override) {
      token = await accessToken(this.env, { rejected: token });
      response = await this.send(method, path, body, token);
    }
    const data = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    if (response.ok) return data as T;
    const name = data?.error ?? `HTTP ${response.status}`;
    const message = data?.message ? `${name}: ${data.message}` : name;
    if (response.status >= 500) throw new CliError(message, 75);
    throw new CliError(message, 1, response.status === 401 ? LOGIN_HINT : undefined);
  }

  private async send(method: Method, path: string, body: unknown, token: string): Promise<Response> {
    try {
      return await fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new CliError(`could not reach ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`, 75);
    }
  }
}
