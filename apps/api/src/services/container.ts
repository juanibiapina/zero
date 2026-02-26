/**
 * ============================================================================
 * Container Service — Cloudflare Container Runtime
 * ============================================================================
 *
 * Wraps @cloudflare/containers to provide container handles for agent sessions.
 */

import { getContainer as cfGetContainer, switchPort } from "@cloudflare/containers";
import type { Env } from "../types";

/** A handle to a named container instance */
export interface ContainerHandle {
  /** Bind this container to a session for lifecycle notifications. */
  bindToSession(sessionDOId: string): Promise<void>;

  /** Get current container state. */
  getState(): Promise<{ status: string }>;

  /** Send HTTP request to the container application. */
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

/** Get a handle to a named container */
export function getContainer(env: Env, name: string): ContainerHandle {
  const container = cfGetContainer(env.AGENT_CONTAINER, name);

  return {
    async bindToSession(sessionDOId: string): Promise<void> {
      await container.setSessionDOId(sessionDOId);
    },

    async getState(): Promise<{ status: string }> {
      const state = await container.getState();
      return { status: state.status };
    },

    fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const request = new Request(input, init);
      return container.fetch(switchPort(request, 8080));
    },
  };
}
