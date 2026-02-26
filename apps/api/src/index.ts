import { createApp } from "./app";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return createApp().fetch(req, env, ctx);
  },
};

export { UserDO } from "./UserDO";
export { SessionDO } from "./SessionDO";
export { AgentContainer } from "./AgentContainer";
