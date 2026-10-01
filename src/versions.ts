import { sort } from 'semver';
import { type Environment, oneMinuteInSeconds } from './common';
import type { Releases } from './releases';

const ttl = oneMinuteInSeconds * 5;

export class Versions {
   public constructor(private readonly releases: Releases) {}

   public async serve(_: Request | undefined, env: Environment): Promise<Response> {
      const snapshot = await this.releases.snapshot(env);
      const latest = snapshot.latest;
      const latestName = latest.toString();
      const all = sort(snapshot.all).reverse();

      const payload = all.map(v => {
         const name = v.toString();
         const isLatest = name === latestName;
         return {
            version: isLatest ? '..' : `v${name}`,
            title: isLatest ? `Latest (${name})` : name,
            aliases: isLatest ? ['latest'] : [],
            latest: isLatest ? true : undefined,
         };
      });
      const response = new Response(JSON.stringify(payload));
      response.headers.set('Cache-Control', `public, max-age=${ttl}`);
      response.headers.set('Content-Type', 'application/json');

      return response;
   }
}
