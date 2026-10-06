import { rcompare, type SemVer } from 'semver';
import { type Environment, oneMinuteInSeconds } from './common';
import type { Releases } from './releases';

export class ReleaseMetadata {
   public constructor(private readonly releases: Releases) {}

   public async serve(env: Environment, version?: SemVer): Promise<Response> {
      const snapshot = await this.releases.snapshot(env);
      const current = version ?? snapshot.latest;
      if (!snapshot.all.some(v => v.version === current.version)) {
         return new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } });
      }

      const stable = snapshot.all.filter(v => v.prerelease.length === 0).sort(rcompare);
      const previous = stable.find(v => v.compare(current) < 0);
      const previousMinor = stable.find(
         v => v.major < current.major || (v.major === current.major && v.minor < current.minor),
      );

      const response = new Response(
         JSON.stringify({
            ...(previous ? { previous: `v${previous.version}` } : {}),
            isLatest: current.version === snapshot.latest.version,
            latest: { title: `Latest (${snapshot.latest.version})`, path: '/' },
            ...(previousMinor ? { previousMajorMinor: `v${previousMinor.major}.${previousMinor.minor}` } : {}),
         }),
      );
      response.headers.set('Cache-Control', `public, max-age=${oneMinuteInSeconds * 5}`);
      response.headers.set('Content-Type', 'application/json');
      return response;
   }
}
