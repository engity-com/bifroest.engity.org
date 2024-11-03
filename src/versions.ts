import { Environment, oneMinuteInSeconds } from './common';
import { Releases } from './releases';

const ttl = oneMinuteInSeconds * 5;

export class Versions {
   public constructor(private readonly releases: Releases) {}

   public async serve(_: Request | undefined, env: Environment): Promise<Response> {
      const latest = await this.releases.latest(env);
      const latestName = latest.toString();
      const all = await this.releases.all(env);

      const payload = all.map((v) => {
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
      response.headers.set('Cache-Control', `public, max-age=${ttl}, public`);
      response.headers.set('Content-Type', 'application/json');

      return response;
   }
}
