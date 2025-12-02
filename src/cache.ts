import type { ExecutionContext, Cache as WCache } from '@cloudflare/workers-types';
import type { Environment } from './common';

export type CacheDrain = (request: Request, env: Environment) => Promise<Response>;

export class Cache {
   async handle(
      request: Request,
      env: Environment,
      ctx: ExecutionContext,
      drain: CacheDrain,
      force?: boolean,
   ): Promise<Response> {
      const cache = await this.cache();
      const targetUrl = new URL(request.url);

      const fetchRequest = new Request(targetUrl, {
         method: 'GET',
      });

      let response: Response | undefined = force ? undefined : await cache.match(targetUrl);

      if (!response) {
         if (force) {
            console.debug(`Retrieving ${fetchRequest.url}...`);
         } else {
            console.debug(`Cache missed, need to retrieve ${fetchRequest.url}...`);
         }

         response = await drain(fetchRequest, env);

         ctx.waitUntil(cache.put(targetUrl, response.clone()));

         if (force) {
            console.info(`${fetchRequest.url} retrieved. (status: ${response.status})`);
         } else {
            console.info(`Cache missed; ${fetchRequest.url} retrieved. (status: ${response.status})`);
         }
      }

      const etag = response.headers.get('Etag');
      if (etag && etag === request.headers.get('If-None-Match')) {
         return new Response(null, {
            ...response,
            status: 304,
            statusText: undefined,
         });
      }

      // In case of HEAD we retrieved the body from the remote,
      // but should obviously not return this to the client.
      // So, we create a response without body.
      if (request && request.method === 'HEAD') {
         return new Response(null, response);
      }

      return response;
   }

   private async cache(): Promise<WCache> {
      return await caches.open('default');
   }
}
