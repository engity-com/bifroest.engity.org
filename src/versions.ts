import { rcompare, type SemVer } from 'semver';
import { type Environment, oneMinuteInSeconds } from './common';
import type { ReleaseSnapshot, Releases } from './releases';

const ttl = oneMinuteInSeconds * 5;

export class Versions {
   public constructor(private readonly releases: Releases) {}

   public async serve(_: Request | undefined, env: Environment, format: 'v1' | 'v2' = 'v1'): Promise<Response> {
      const snapshot = await this.releases.snapshot(env);
      const latest = snapshot.latest;
      const latestName = latest.toString();
      const visible = visibleVersions(snapshot, format === 'v2');
      const all = format === 'v1' ? [latest, ...visible.filter(v => v.version !== latestName)] : visible;

      const payload = all.map(v => {
         const name = v.toString();
         const isLatest = name === latestName;
         if (format === 'v2') {
            return {
               tag: `v${name}`,
               title: isLatest ? `Latest (${name})` : name,
               path: isLatest ? '/' : `/v${name}/`,
               ...(isLatest ? { aliases: ['/latest/', `/v${name}/`], latest: true } : {}),
               ...(v.prerelease.length > 0 ? { prerelease: true } : {}),
            };
         }
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

function visibleVersions(snapshot: ReleaseSnapshot, includePrerelease: boolean): Array<SemVer> {
   const stable = snapshot.all.filter(v => v.prerelease.length === 0).sort(rcompare);
   const selected: Array<SemVer> = [];
   const majors = new Set<number>();
   const minors = new Map<number, Set<number>>();

   for (const version of stable) {
      if (!majors.has(version.major)) {
         if (majors.size === 3) {
            continue;
         }
         majors.add(version.major);
      }
      let currentMinors = minors.get(version.major);
      if (!currentMinors) {
         currentMinors = new Set<number>();
         minors.set(version.major, currentMinors);
      }
      if (currentMinors.has(version.minor) || currentMinors.size === 3) {
         continue;
      }
      currentMinors.add(version.minor);
      selected.push(version);
   }

   // The homepage must always be represented, even after newer stable releases fill the dropdown.
   if (!selected.some(v => v.version === snapshot.latest.version)) {
      selected.push(snapshot.latest);
   }

   if (includePrerelease) {
      const newestPrerelease = snapshot.all
         .filter(v => v.prerelease.length > 0)
         .sort(rcompare)
         .find(v => stable.length === 0 || stable[0].compare(v) < 0);
      if (newestPrerelease) {
         selected.push(newestPrerelease);
      }
   }

   return selected.sort(rcompare);
}
