/**
 * HTTP server — Plain Node.js http router for agent-server.
 *
 * Routes:
 *   POST /start    — Start a new agent session (clone repo + run prompt)
 *   POST /resume   — Resume session after container sleep/wake
 *   POST /message  — Send a follow-up message
 *   POST /steer    — Steer the agent mid-run
 *   POST /stop     — Stop the current session
 *   GET  /ws       — WebSocket for event streaming
 *   GET  /workspace/snapshot — Snapshot workspace as tar.zst
 *   POST /workspace/restore — Restore workspace from tar.zst
 *   POST /workspace/update-remote — Update git remote URL
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { WebSocketServer } from "ws";
import { EventBuffer } from "./events.js";
import { SessionWrapper } from "./session.js";
import type { Message } from "@mariozechner/pi-ai";
import type { StartRequest, ResumeRequest, MessageRequest, SteerRequest } from "./types.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function parseJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse
): Promise<T | null> {
  try {
    const body = await readBody(req);
    return JSON.parse(body) as T;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function createAppServer(): Server {
  const eventBuffer = new EventBuffer();
  const session = new SessionWrapper(eventBuffer);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method?.toUpperCase() ?? "GET";
    const path = url.pathname;

    try {
      // ── POST /start ─────────────────────────────────────────────────
      if (method === "POST" && path === "/start") {
        const body = await parseJsonBody<StartRequest>(req, res);
        if (!body) return;
        if (!body.provider || !body.model || !body.apiKey) {
          sendJson(res, 400, { error: "Missing required fields: provider, model, apiKey" });
          return;
        }
        if (body.secrets) {
          for (const [name, value] of Object.entries(body.secrets)) {
            process.env[name] = value;
          }
        }
        session
          .start(body.provider, body.model, body.apiKey, body.prompt, body.repoUrl, body.token)
          .catch((err) => console.error("Session start error:", err));
        sendJson(res, 200, { ok: true });
        return;
      }

      // ── POST /resume ────────────────────────────────────────────────
      if (method === "POST" && path === "/resume") {
        const body = await parseJsonBody<ResumeRequest>(req, res);
        if (!body) return;
        if (!body.provider || !body.model || !body.apiKey || !body.repoUrl || !body.token) {
          sendJson(res, 400, { error: "Missing required fields: provider, model, apiKey, repoUrl, token" });
          return;
        }
        if (!Array.isArray(body.messages)) {
          sendJson(res, 400, { error: "Missing required field: messages (array)" });
          return;
        }
        if (body.secrets) {
          for (const [name, value] of Object.entries(body.secrets)) {
            process.env[name] = value;
          }
        }
        try {
          await session.resume(
            body.provider, body.model, body.apiKey,
            body.messages as Message[], body.repoUrl, body.token, body.workspaceRestored,
          );
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // ── POST /message ───────────────────────────────────────────────
      if (method === "POST" && path === "/message") {
        const body = await parseJsonBody<MessageRequest>(req, res);
        if (!body) return;
        if (!body.text) {
          sendJson(res, 400, { error: "Missing required field: text" });
          return;
        }
        try {
          await session.sendMessage(body.text);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // ── POST /steer ─────────────────────────────────────────────────
      if (method === "POST" && path === "/steer") {
        const body = await parseJsonBody<SteerRequest>(req, res);
        if (!body) return;
        if (!body.text) {
          sendJson(res, 400, { error: "Missing required field: text" });
          return;
        }
        try {
          await session.steer(body.text);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // ── POST /stop ──────────────────────────────────────────────────
      if (method === "POST" && path === "/stop") {
        await session.stop();
        sendJson(res, 200, { ok: true });
        return;
      }

      // ── GET /workspace/snapshot ─────────────────────────────────────
      if (method === "GET" && path === "/workspace/snapshot") {
        const repoDir = "/workspace/repo";
        if (!existsSync(repoDir)) {
          sendJson(res, 404, { error: "No workspace to snapshot" });
          return;
        }
        res.writeHead(200, { "Content-Type": "application/zstd", "Transfer-Encoding": "chunked" });
        const tar = spawn("tar", ["-C", "/workspace", "-cf", "-", "repo"], { stdio: ["ignore", "pipe", "pipe"] });
        const zstd = spawn("zstd", ["-1", "-"], { stdio: ["pipe", "pipe", "pipe"] });
        tar.stdout.pipe(zstd.stdin);
        zstd.stdout.on("data", (chunk: Buffer) => res.write(chunk));
        let errOutput = "";
        tar.stderr.on("data", (d: Buffer) => { errOutput += d.toString(); });
        zstd.stderr.on("data", (d: Buffer) => { errOutput += d.toString(); });
        zstd.on("close", (code) => {
          if (code !== 0) console.error("Snapshot failed:", errOutput);
          res.end();
        });
        tar.on("error", (err) => { console.error("Snapshot tar error:", err); res.end(); });
        zstd.on("error", (err) => { console.error("Snapshot zstd error:", err); res.end(); });
        req.on("close", () => { tar.kill(); zstd.kill(); });
        return;
      }

      // ── POST /workspace/update-remote ───────────────────────────────
      if (method === "POST" && path === "/workspace/update-remote") {
        const body = await parseJsonBody<{ repoUrl: string; token: string }>(req, res);
        if (!body) return;
        if (!body.repoUrl || !body.token) {
          sendJson(res, 400, { error: "Missing repoUrl or token" });
          return;
        }
        const repoDir = "/workspace/repo";
        if (!existsSync(repoDir)) {
          sendJson(res, 404, { error: "No workspace" });
          return;
        }
        const authedUrl = body.repoUrl.replace("https://", `https://x-access-token:${body.token}@`);
        execSync(`git -C ${repoDir} remote set-url origin ${authedUrl}`);
        execSync(`git -C ${repoDir} remote set-url origin ${body.repoUrl}`);
        sendJson(res, 200, { ok: true });
        return;
      }

      // ── POST /workspace/restore ─────────────────────────────────────
      if (method === "POST" && path === "/workspace/restore") {
        if (existsSync("/workspace/repo")) {
          execSync("rm -rf /workspace/repo");
        }
        const zstd = spawn("zstd", ["-d"], { stdio: ["pipe", "pipe", "pipe"] });
        const tar = spawn("tar", ["-C", "/workspace", "-xf", "-"], { stdio: ["pipe", "pipe", "pipe"] });
        zstd.stdout.pipe(tar.stdin);
        req.pipe(zstd.stdin);
        let errOutput = "";
        zstd.stderr.on("data", (d: Buffer) => { errOutput += d.toString(); });
        tar.stderr.on("data", (d: Buffer) => { errOutput += d.toString(); });
        await new Promise<void>((resolve, reject) => {
          tar.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Restore failed (exit ${code}): ${errOutput}`));
          });
          tar.on("error", reject);
          zstd.on("error", reject);
        });
        if (existsSync("/workspace/repo")) process.chdir("/workspace/repo");
        sendJson(res, 200, { ok: true });
        return;
      }

      // ── GET /status ──────────────────────────────────────────────────
      if (method === "GET" && path === "/status") {
        sendJson(res, 200, { status: session.status });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("Unhandled error:", err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  // ── WebSocket upgrade for /ws ───────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const afterSeq = parseInt(url.searchParams.get("after") ?? "0", 10);
      eventBuffer.registerWebSocket(ws, afterSeq);
      ws.on("message", (raw) => {
        let data: { type: string };
        try {
          data = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8"));
        } catch { return; }
        if (data.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      });
      ws.on("close", () => eventBuffer.unregisterWebSocket(ws));
      ws.on("error", () => eventBuffer.unregisterWebSocket(ws));
    });
  });

  return server;
}
