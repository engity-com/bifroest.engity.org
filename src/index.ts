import { App } from './app';
import { Environment } from './common';

const app = new App();

export const handler = {
   async fetch(request: Request, env: Environment, ctx: ExecutionContext): Promise<Response> {
      return await app.fetch(request, env, ctx);
   },

   async scheduled(scheduledController: ScheduledController, env: Environment, ctx: ExecutionContext): Promise<void> {
      return await app.scheduled(scheduledController, env, ctx);
   },
};

// noinspection JSUnusedGlobalSymbols
export default handler;
