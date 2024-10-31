import { Octokit } from '@octokit/rest';
import { SemVer } from 'semver';
import semver from 'semver/preload';
import { Environment, oneHourInSeconds } from './common';

const maxRetrieveTries = 25;
const cacheKvSettings = {
   expirationTtl: oneHourInSeconds,
};

const docsRefPrefix = 'refs/tags/docs/';

export class Releases {
   public async latest(env: Environment): Promise<SemVer> {
      for (let i = 0; i < maxRetrieveTries; i++) {
         const plain = await env.KV.get('release-latest', {
            cacheTtl: oneHourInSeconds,
         });
         if (plain) {
            return this._toSemver(plain);
         }
         await this.update(env);
      }
      throw `Was not able to retrieve the latest release after ${maxRetrieveTries} tries.`;
   }

   public async all(env: Environment): Promise<Array<SemVer>> {
      return (await this._all(env)).map((v) => this._toSemver(v));
   }

   private async _all(env: Environment): Promise<Array<string>> {
      for (let i = 0; i < maxRetrieveTries; i++) {
         const plain = await env.KV.get('releases-sorted', {
            cacheTtl: oneHourInSeconds,
         });
         if (plain) {
            return JSON.parse(plain) as Array<string>;
         }
         await this.update(env);
      }
      throw `Was not able to retrieve the all releases sorted after ${maxRetrieveTries} tries.`;
   }

   public async has(env: Environment, version: string | SemVer): Promise<boolean> {
      const all = await this._all(env);
      return all && all.indexOf(typeof version === 'string' ? version : version.toString()) >= 0;
   }

   public async update(env: Environment) {
      const octokit = new Octokit({
         auth: env.GITHUB_ACCESS_TOKEN,
      });
      let latest: SemVer | undefined = undefined;
      const all: Array<SemVer> = [];
      for await (const response of octokit.paginate.iterator('GET /repos/{owner}/{repo}/git/matching-refs/tags/docs', {
         owner: env.GITHUB_ORGANIZATION,
         repo: env.GITHUB_REPOSITORY,
         per_page: 100,
      })) {
         for (const v of response.data) {
            // @ts-ignore
            const ref = v.ref as string;
            if (!ref.startsWith(docsRefPrefix)) {
               continue;
            }
            const plain = ref.substring(docsRefPrefix.length);
            const current = semver.parse(plain);
            if (!current) {
               continue;
            }

            if (!current.prerelease || current.prerelease.length === 0) {
               if (!latest || semver.gt(current, latest, { loose: true })) {
                  latest = current;
               }
            }

            all.push(current);
         }
      }

      if (!latest) {
         throw 'There is no latest version are available.';
      }

      await env.KV.put('release-latest', latest.toString(), cacheKvSettings);

      const allSorted = all
         .map((v) => v.toString())
         .sort()
         .reverse();

      await env.KV.put('releases-sorted', JSON.stringify(allSorted), cacheKvSettings);
   }

   private _toSemver(plain: string | null | undefined): SemVer {
      if (!plain) {
         throw `There was an empty version provided which should not be empty.`;
      }
      const result = semver.parse(plain);
      if (!result) {
         throw `"${plain}" is not a valid version.`;
      }
      return result;
   }
}
