import {Environment, oneMinuteInSeconds} from './common';
import {Releases} from './releases';

export class VersionsHandler {

   public constructor(
      private releases: Releases,
   ) {}

   public async handle(request: Request, env: Environment): Promise<Response> {
      const latest = await this.releases.latest(request, env);
      const latestName = latest.toString();
      const all = await this.releases.all(request, env);

      const url = new URL('https://bifroest.engity.org/versions.json');
      const ttl = oneMinuteInSeconds * 5;
      const cacheKey = new Request(url, {
         method: 'GET',
      });
      const cache = await caches.open('default');

      for (let run = 0; run < 10; run++) {
         const response = await cache.match(cacheKey);

         if (response) {
            if (request.method === 'HEAD') {
               // In case of HEAD we retrieved the body from the remote,
               // but should obviously not return this to the client.
               // So, we create a response without body.
               return new Response(null, response);
            }
            return response;
         }

         if (run === 0) {
            console.debug(`Cache missed, need to create it: ${url}...`);
         }

         const payload = all.map(v => {
            const name = v.toString();
            const isLatest = name === latestName;
            return {
               version: isLatest ? '..' : `v${name}`,
               title: isLatest ? `Latest (${name})` : name,
               aliases: isLatest ? ['latest'] : [],
               latest: isLatest ? true : undefined,
            };
         })
         const toCacheResponse = new Response(JSON.stringify(payload));
         toCacheResponse.headers.set('Cache-Control', `public, max-age=${ttl}, public`);
         toCacheResponse.headers.set('Content-Type', 'application/json');
         await cache.put(cacheKey, toCacheResponse);

         console.debug(`Cache missed, need to create it: ${url}... DONE!`);
      }

      console.error(`Cache missed, need to create it: ${url}... FAILED (reason: unknown)!`);
      return new Response(null, {
         status: 400,
      });
   }
}
