import { Octokit } from '@octokit/rest';
import type { SemVer } from 'semver';
import semver from 'semver/preload';
import { type Environment, oneHourInSeconds, oneMinuteInSeconds } from './common';

const docsRefPrefix = 'refs/tags/docs/';
const snapshotKey = 'releases-verified';
const maxSnapshotAge = 3 * oneHourInSeconds * 1000;
const refreshInterval = oneMinuteInSeconds * 1000;

export interface ReleaseSnapshot {
   latest: SemVer;
   all: Array<SemVer>;
}

export class LatestUnavailableError extends Error {}

export class Releases {
   private verifying?: Promise<ReleaseSnapshot>;
   private recentlyVerified?: { snapshot: ReleaseSnapshot; until: number };
   private verificationFailure?: { error: LatestUnavailableError; retryAfter: number };
   private generation = 0;

   public async snapshot(env: Environment): Promise<ReleaseSnapshot> {
      const plain = await env.KV.get(snapshotKey, { cacheTtl: oneMinuteInSeconds });
      if (plain) {
         const saved = JSON.parse(plain) as { latest: string; all: Array<string>; verifiedAt?: number };
         if (
            typeof saved.verifiedAt === 'number' &&
            Date.now() - saved.verifiedAt < maxSnapshotAge &&
            saved.verifiedAt <= Date.now()
         ) {
            return {
               latest: this._toSemver(saved.latest),
               all: saved.all.map(v => this._toSemver(v)),
            };
         }
      }

      // Old snapshots without verifiedAt and expired snapshots must be checked again.
      // Request handlers never write KV; only the scheduled update does.
      if (this.recentlyVerified && this.recentlyVerified.until > Date.now()) {
         return this.recentlyVerified.snapshot;
      }
      if (this.verificationFailure && this.verificationFailure.retryAfter > Date.now()) {
         throw this.verificationFailure.error;
      }
      const generation = this.generation;
      this.verifying ??= this.verify(env)
         .then(snapshot => {
            if (generation !== this.generation && this.recentlyVerified) {
               return this.recentlyVerified.snapshot;
            }
            this.verificationFailure = undefined;
            this.recentlyVerified = { snapshot, until: Date.now() + refreshInterval };
            return snapshot;
         })
         .catch(cause => {
            if (generation !== this.generation && this.recentlyVerified) {
               return this.recentlyVerified.snapshot;
            }
            const error = new LatestUnavailableError('Latest release could not be verified.', { cause });
            this.verificationFailure = { error, retryAfter: Date.now() + refreshInterval };
            throw error;
         })
         .finally(() => {
            this.verifying = undefined;
         });
      return this.verifying;
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
      const snapshot = await this.verify(env);
      await env.KV.put(
         snapshotKey,
         JSON.stringify({
            latest: snapshot.latest.version,
            all: snapshot.all.map(v => v.version),
            verifiedAt: Date.now(),
         }),
      );
      this.generation++;
      this.recentlyVerified = { snapshot, until: Date.now() + refreshInterval };
      this.verificationFailure = undefined;
      return snapshot;
   }

   private async verify(env: Environment): Promise<ReleaseSnapshot> {
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
