import { Octokit } from '@octokit/rest';
import type { SemVer } from 'semver';
import semver from 'semver/preload';
import { type Environment, oneMinuteInSeconds } from './common';

const docsRefPrefix = 'refs/tags/docs/';
const snapshotKey = 'releases-verified';

export interface ReleaseSnapshot {
   latest: SemVer;
   all: Array<SemVer>;
}

export class Releases {
   public async snapshot(env: Environment): Promise<ReleaseSnapshot> {
      const plain = await env.KV.get(snapshotKey, { cacheTtl: oneMinuteInSeconds });
      if (!plain) {
         return this.update(env);
      }
      const saved = JSON.parse(plain) as { latest: string; all: Array<string> };
      return {
         latest: this._toSemver(saved.latest),
         all: saved.all.map(v => this._toSemver(v)),
      };
   }

   public async latest(env: Environment): Promise<SemVer> {
      return (await this.snapshot(env)).latest;
   }

   public async all(env: Environment): Promise<Array<SemVer>> {
      return (await this.snapshot(env)).all;
   }

   public async has(env: Environment, version: string | SemVer): Promise<boolean> {
      return (await this.all(env)).some(v => v.toString() === version.toString());
   }

   public async update(env: Environment): Promise<ReleaseSnapshot> {
      const octokit = new Octokit({ auth: env.GITHUB_ACCESS_TOKEN });
      const release = (
         await octokit.request('GET /repos/{owner}/{repo}/releases/latest', {
            owner: env.GITHUB_ORGANIZATION,
            repo: env.GITHUB_REPOSITORY,
         })
      ).data;
      const tag = release.tag_name;
      const version = semver.parse(tag);
      if (
         !version ||
         tag !== `v${version}` ||
         version.prerelease.length > 0 ||
         release.draft ||
         release.prerelease ||
         !release.published_at
      ) {
         throw new Error(`GitHub latest release ${tag} is not a published stable release.`);
      }

      const all: Array<SemVer> = [];
      for await (const response of octokit.paginate.iterator('GET /repos/{owner}/{repo}/git/matching-refs/tags/docs', {
         owner: env.GITHUB_ORGANIZATION,
         repo: env.GITHUB_REPOSITORY,
         per_page: 100,
      })) {
         for (const ref of response.data) {
            const name = (ref as { ref: string }).ref;
            if (!name.startsWith(docsRefPrefix)) {
               continue;
            }
            const tag = name.substring(docsRefPrefix.length);
            const current = semver.parse(tag);
            if (current && tag === `v${current}`) {
               all.push(current);
            }
         }
      }

      if (!all.some(v => v.version === version.version)) {
         throw new Error(`Docs tag docs/${tag} is missing; keeping last verified release.`);
      }

      const homepage = await fetch(
         `https://raw.githubusercontent.com/${env.GITHUB_ORGANIZATION}/${env.GITHUB_REPOSITORY}/refs/tags/docs/${tag}/index.html`,
         { headers: { Authorization: `Basic ${btoa(`${env.GITHUB_ACCESS_USER}:${env.GITHUB_ACCESS_TOKEN}`)}` } },
      );
      if (!homepage.ok) {
         throw new Error(
            `Docs homepage for ${tag} is unavailable (${homepage.status}); keeping last verified release.`,
         );
      }
      await homepage.body?.cancel();

      const sorted = semver.rsort(all.map(v => v.version));
      // This is the only write: failed verification never replaces the last good snapshot.
      await env.KV.put(snapshotKey, JSON.stringify({ latest: version.version, all: sorted }));
      return { latest: version, all: sorted.map(v => this._toSemver(v)) };
   }

   private _toSemver(plain: string): SemVer {
      const result = semver.parse(plain);
      if (!result) {
         throw new Error(`"${plain}" is not a valid version.`);
      }
      return result;
   }
}
