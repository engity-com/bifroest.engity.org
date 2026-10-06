import type { ExecutionContext, KVNamespace } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, AppCachingStrategy } from './app';
import type { Environment } from './common';
import { Contents } from './contents';
import { ReleaseMetadata } from './release-metadata';
import { Releases } from './releases';
import { Router } from './router';
import { Versions } from './versions';

const github = vi.hoisted(() => ({
   release: { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-01-01' },
   refs: ['refs/tags/docs/v1.0.0', 'refs/tags/docs/v2.0.0'],
   failure: false,
   requests: 0,
   pauseRequest: undefined as Promise<void> | undefined,
}));

vi.mock('@octokit/rest', () => ({
   Octokit: class {
      request = async (route: string) => {
         github.requests++;
         if (route !== 'GET /repos/{owner}/{repo}/releases/latest') {
            throw new Error(`Unexpected GitHub endpoint: ${route}`);
         }
         const release = { ...github.release };
         await github.pauseRequest;
         if (github.failure) {
            throw new Error('GitHub unavailable');
         }
         return { data: release };
      };
      paginate = {
         iterator: async function* () {
            if (github.failure) {
               throw new Error('GitHub unavailable');
            }
            yield { data: github.refs.map(ref => ({ ref })) };
         },
      };
   },
}));

describe('GitHub latest release', () => {
   const values = new Map<string, string>();
   let staleRead = false;
   const put = vi.fn(async (key: string, value: string) => {
      values.set(key, value);
   });
   const env = {
      KV: {
         get: async (key: string) => (staleRead ? null : (values.get(key) ?? null)),
         put,
      } as unknown as KVNamespace,
      GITHUB_ORGANIZATION: 'example',
      GITHUB_REPOSITORY: 'bifroest',
      GITHUB_ACCESS_USER: 'user',
      GITHUB_ACCESS_TOKEN: 'token',
   } as Environment;
   let releases: Releases;

   beforeEach(() => {
      releases = new Releases();
      values.clear();
      staleRead = false;
      put.mockClear();
      github.release = { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-01-01' };
      github.refs = ['refs/tags/docs/v1.0.0', 'refs/tags/docs/v2.0.0'];
      github.failure = false;
      github.requests = 0;
      github.pauseRequest = undefined;
      vi.stubGlobal(
         'fetch',
         vi.fn(async () => new Response('home', { status: 200 })),
      );
   });

   it("uses GitHub's manually selected older stable release, not the highest docs version", async () => {
      expect((await releases.update(env)).latest.version).toBe('1.0.0');
      const router = new Router(new Contents(releases), new Versions(releases), new ReleaseMetadata(releases));
      const home = await router.handle(new Request('https://example.org/'), env);
      expect(home.headers.get('X-Version')).toBe('1.0.0');
      expect(home.headers.get('Cache-Control')).toBe('public, max-age=300');
      const alias = await router.handle(new Request('https://example.org/latest/'), env);
      expect(alias.status).toBe(307);
      expect(alias.headers.get('Location')).toBe('https://example.org/');
      const payload = (await (await new Versions(releases).serve(undefined, env)).json()) as Array<{
         title: string;
         latest?: boolean;
      }>;
      expect(payload.find(v => v.latest)?.title).toBe('Latest (1.0.0)');
      expect(payload.find(v => v.title === '2.0.0')?.latest).toBeUndefined();
   });

   it.each(['alpha1', 'beta1'])('serves explicit %s docs without assigning the latest alias', async suffix => {
      github.refs.push(`refs/tags/docs/v2.0.0-${suffix}`);
      await releases.update(env);
      const router = new Router(new Contents(releases), new Versions(releases), new ReleaseMetadata(releases));
      const response = await router.handle(new Request(`https://example.org/v2.0.0-${suffix}/`), env);
      expect(response.headers.get('X-Version')).toBe(`2.0.0-${suffix}`);
      const v1 = (await (await router.handle(new Request('https://example.org/versions.json'), env)).json()) as Array<{
         title: string;
         aliases: Array<string>;
      }>;
      expect(v1.map(v => v.title)).toEqual(['Latest (1.0.0)', '2.0.0']);
      const v2 = (await (
         await router.handle(new Request('https://example.org/versions-v2.json'), env)
      ).json()) as Array<{
         tag: string;
         aliases?: Array<string>;
      }>;
      expect(v2.find(v => v.tag === `v2.0.0-${suffix}`)?.aliases).toBeUndefined();
   });

   it('keeps v1 compatible and uses paths and tags rather than list position in v2', async () => {
      github.refs = ['v1.0.0-beta1', 'v0.7.7', 'v0.7.6'].map(v => `refs/tags/docs/${v}`);
      github.release.tag_name = 'v0.7.7';
      await releases.update(env);
      const router = new Router(new Contents(releases), new Versions(releases), new ReleaseMetadata(releases));

      const v1 = await (await router.handle(new Request('https://example.org/versions.json'), env)).json();
      const v1Alias = await (await router.handle(new Request('https://example.org/versions-v1.json'), env)).json();
      expect(v1Alias).toEqual(v1);
      expect(v1).toEqual([{ version: '..', title: 'Latest (0.7.7)', aliases: ['latest'], latest: true }]);

      const v2 = await (await router.handle(new Request('https://example.org/versions-v2.json'), env)).json();
      expect(v2).toEqual([
         { tag: 'v1.0.0-beta1', title: '1.0.0-beta1', path: '/v1.0.0-beta1/', prerelease: true },
         {
            tag: 'v0.7.7',
            title: 'Latest (0.7.7)',
            path: '/',
            aliases: ['/latest/', '/v0.7.7/'],
            latest: true,
         },
      ]);
      expect(
         (await router.handle(new Request('https://example.org/v1.0.0-beta1/'), env)).headers.get('X-Version'),
      ).toBe('1.0.0-beta1');
   });

   it('limits patches, minors and majors while keeping latest and one unfinished prerelease', async () => {
      github.refs = [
         'v0.7.6',
         'v0.7.7',
         'v1.0.0',
         'v2.1.0',
         'v2.2.0',
         'v2.2.1',
         'v2.3.0',
         'v2.4.0',
         'v3.0.0',
         'v4.0.0',
         'v5.0.0-beta1',
         'v5.0.0-beta2',
      ].map(v => `refs/tags/docs/${v}`);
      github.release.tag_name = 'v0.7.7';
      await releases.update(env);
      const router = new Router(new Contents(releases), new Versions(releases), new ReleaseMetadata(releases));

      const v1 = (await (
         await router.handle(new Request('https://example.org/versions-v1.json'), env)
      ).json()) as Array<{
         version: string;
      }>;
      expect(v1.map(v => v.version)).toEqual(['..', 'v4.0.0', 'v3.0.0', 'v2.4.0', 'v2.3.0', 'v2.2.1']);

      const v2 = (await (
         await router.handle(new Request('https://example.org/versions-v2.json'), env)
      ).json()) as Array<{
         tag: string;
      }>;
      expect(v2.map(v => v.tag)).toEqual(['v5.0.0-beta2', 'v4.0.0', 'v3.0.0', 'v2.4.0', 'v2.3.0', 'v2.2.1', 'v0.7.7']);
      expect((await router.handle(new Request('https://example.org/v0.7.6/'), env)).status).toBe(200);
      expect(await (await router.handle(new Request('https://example.org/v2.1.0/release.json'), env)).json()).toEqual({
         previous: 'v1.0.0',
         isLatest: false,
         previousMajorMinor: 'v1.0',
      });

      github.refs.push('refs/tags/docs/v5.0.0');
      await releases.update(env);
      const afterRelease = (await (
         await router.handle(new Request('https://example.org/versions-v2.json'), env)
      ).json()) as Array<{
         tag: string;
      }>;
      expect(afterRelease.map(v => v.tag)).toEqual(['v5.0.0', 'v4.0.0', 'v3.0.0', 'v0.7.7']);
   });

   it('provides stable predecessors independent of dropdown filtering and refreshes isLatest', async () => {
      github.refs = ['v0.7.6', 'v0.7.7', 'v1.0.0-beta1', 'v1.0.0'].map(v => `refs/tags/docs/${v}`);
      github.release.tag_name = 'v0.7.7';
      await releases.update(env);
      const router = new Router(new Contents(releases), new Versions(releases), new ReleaseMetadata(releases));

      const beta = await router.handle(new Request('https://example.org/v1.0.0-beta1/release.json'), env);
      expect(await beta.json()).toEqual({ previous: 'v0.7.7', isLatest: false, previousMajorMinor: 'v0.7' });
      expect(beta.headers.get('Cache-Control')).toBe('public, max-age=300');
      expect(beta.headers.get('Content-Type')).toBe('application/json');
      const current = await router.handle(new Request('https://example.org/release.json'), env);
      expect(await current.json()).toEqual({ previous: 'v0.7.6', isLatest: true });
      expect(await (await router.handle(new Request('https://example.org/v0.7.6/release.json'), env)).json()).toEqual({
         isLatest: false,
      });
      expect(await (await router.handle(new Request('https://example.org/v0.7.7/release.json'), env)).json()).toEqual({
         previous: 'v0.7.6',
         isLatest: true,
      });
      expect((await router.handle(new Request('https://example.org/v9.0.0/release.json'), env)).status).toBe(404);

      github.release.tag_name = 'v1.0.0';
      await releases.update(env);
      expect(await (await router.handle(new Request('https://example.org/release.json'), env)).json()).toEqual({
         previous: 'v0.7.7',
         isLatest: true,
         previousMajorMinor: 'v0.7',
      });
      expect(await (await router.handle(new Request('https://example.org/v0.7.7/release.json'), env)).json()).toEqual({
         previous: 'v0.7.6',
         isLatest: false,
      });
      const alias = await router.handle(new Request('https://example.org/latest/release.json'), env);
      expect(alias.status).toBe(307);
      expect(alias.headers.get('Location')).toBe('https://example.org/release.json');
   });

   it.each(['v2.0.0-alpha1', 'v2.0.0-beta1'])(
      'rejects a prerelease tag %s even without a prerelease flag',
      async tag => {
         github.release.tag_name = tag;
         await expect(releases.update(env)).rejects.toThrow('not a published stable');
         expect(values.has('releases-verified')).toBe(false);
      },
   );

   it('rejects draft, prerelease flags and unpublished releases', async () => {
      for (const field of ['draft', 'prerelease', 'published_at'] as const) {
         github.release = {
            ...github.release,
            [field]: field === 'published_at' ? null : true,
         } as typeof github.release;
         await expect(releases.update(env)).rejects.toThrow('not a published stable');
         github.release = { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-01-01' };
      }
   });

   it('does not promote when the docs tag or homepage is missing', async () => {
      github.refs = ['refs/tags/docs/v2.0.0'];
      await expect(releases.update(env)).rejects.toThrow('Docs tag');
      github.refs = ['refs/tags/docs/v1.0.0'];
      vi.stubGlobal(
         'fetch',
         vi.fn(async () => new Response(null, { status: 404 })),
      );
      await expect(releases.update(env)).rejects.toThrow('homepage');
      expect(values.has('releases-verified')).toBe(false);
   });

   it('keeps the verified snapshot on GitHub failures and invalid later selections', async () => {
      await releases.update(env);
      const saved = values.get('releases-verified');
      github.failure = true;
      await expect(releases.update(env)).rejects.toThrow('GitHub unavailable');
      github.failure = false;
      github.release.tag_name = 'v2.0.0-beta1';
      await expect(releases.update(env)).rejects.toThrow('not a published stable');
      expect(values.get('releases-verified')).toBe(saved);
      expect((await releases.latest(env)).version).toBe('1.0.0');
   });

   it('fails closed without a verified snapshot when the GitHub API is unavailable', async () => {
      github.failure = true;
      await expect(releases.latest(env)).rejects.toThrow('Latest release could not be verified');
   });

   it('coalesces simultaneous cold reads without writing to KV', async () => {
      const latest = await Promise.all(Array.from({ length: 10 }, () => releases.latest(env)));
      expect(latest.map(v => v.version)).toEqual(Array(10).fill('1.0.0'));
      expect(github.requests).toBe(1);
      expect(put).not.toHaveBeenCalled();
      expect((await releases.latest(env)).version).toBe('1.0.0');
      expect(github.requests).toBe(1);
   });

   it('backs off failed checks within an instance and retries after a minute', async () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
         github.failure = true;
         await expect(releases.latest(env)).rejects.toThrow('Latest release could not be verified');
         await expect(releases.latest(env)).rejects.toThrow('Latest release could not be verified');
         expect(github.requests).toBe(1);

         clock.mockReturnValue(now + 61_000);
         github.failure = false;
         expect((await releases.latest(env)).version).toBe('1.0.0');
         expect(github.requests).toBe(2);
         expect(put).not.toHaveBeenCalled();
      } finally {
         clock.mockRestore();
      }
   });

   it('ignores a failed request verification completed after a successful cron update', async () => {
      let unblock!: () => void;
      github.pauseRequest = new Promise(resolve => {
         unblock = resolve;
      });
      const pending = releases.latest(env);
      await vi.waitFor(() => expect(github.requests).toBe(1));

      github.pauseRequest = undefined;
      await releases.update(env);
      github.failure = true;
      staleRead = true;
      unblock();

      expect((await pending).version).toBe('1.0.0');
      expect((await releases.latest(env)).version).toBe('1.0.0');
      expect(github.requests).toBe(2);
   });

   it('ignores an obsolete verification result after the cron selects a newer release', async () => {
      let unblock!: () => void;
      github.pauseRequest = new Promise(resolve => {
         unblock = resolve;
      });
      const pending = releases.latest(env);
      await vi.waitFor(() => expect(github.requests).toBe(1));

      github.pauseRequest = undefined;
      github.release.tag_name = 'v2.0.0';
      await releases.update(env);
      staleRead = true;
      unblock();

      expect((await pending).version).toBe('2.0.0');
      expect((await releases.latest(env)).version).toBe('2.0.0');
   });

   it('keeps the latest alias short-lived even for content-hashed assets', async () => {
      await releases.update(env);
      const router = new Router(new Contents(releases), new Versions(releases), new ReleaseMetadata(releases));
      const latestAsset = await router.handle(new Request('https://example.org/file.abcdef12.min.js'), env);
      const versionedAsset = await router.handle(new Request('https://example.org/v1.0.0/file.abcdef12.min.js'), env);
      expect(latestAsset.headers.get('Cache-Control')).toBe('public, max-age=300');
      expect(versionedAsset.headers.get('Cache-Control')).toBe('public, max-age=31536000');
   });

   it('uses a recently verified snapshot during a GitHub outage', async () => {
      await releases.update(env);
      expect(JSON.parse(values.get('releases-verified') ?? '{}').verifiedAt).toBeTypeOf('number');
      github.failure = true;
      expect((await releases.latest(env)).version).toBe('1.0.0');
   });

   it('rechecks expired snapshots without KV writes and fails closed if GitHub is unavailable', async () => {
      values.set(
         'releases-verified',
         JSON.stringify({
            latest: '1.0.0',
            all: ['1.0.0'],
            verifiedAt: Date.now() - 3 * 60 * 60 * 1000 - 1,
         }),
      );
      github.release.tag_name = 'v2.0.0';
      expect((await releases.latest(env)).version).toBe('2.0.0');
      expect(put).not.toHaveBeenCalled();

      releases = new Releases();
      github.failure = true;
      await expect(releases.latest(env)).rejects.toThrow('Latest release could not be verified');
      expect(values.get('releases-verified')).toContain('"latest":"1.0.0"');
   });

   it('returns an uncached 503 when an expired snapshot cannot be verified', async () => {
      values.set(
         'releases-verified',
         JSON.stringify({
            latest: '1.0.0',
            all: ['1.0.0'],
            verifiedAt: Date.now() - 3 * 60 * 60 * 1000 - 1,
         }),
      );
      github.failure = true;
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
         const response = await new App().fetch(
            new Request('https://example.org/'),
            env,
            {} as ExecutionContext,
            AppCachingStrategy.byPass,
         );
         expect(response.status).toBe(503);
         expect(response.headers.get('Cache-Control')).toBe('no-store');
         expect(response.headers.get('Retry-After')).toBe('60');
         expect(put).not.toHaveBeenCalled();
      } finally {
         log.mockRestore();
      }
   });

   it('does not put verification failures into the HTTP cache', async () => {
      github.failure = true;
      const putResponse = vi.fn();
      vi.stubGlobal('caches', {
         open: async () => ({ match: async () => undefined, put: putResponse }),
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
         const response = await new App().fetch(new Request('https://example.org/'), env, {
            waitUntil: vi.fn(),
         } as unknown as ExecutionContext);
         expect(response.status).toBe(503);
         expect(response.headers.get('Cache-Control')).toBe('no-store');
         expect(putResponse).not.toHaveBeenCalled();
      } finally {
         log.mockRestore();
         vi.unstubAllGlobals();
      }
   });

   it('keeps explicit version 404 responses independent of latest verification', async () => {
      values.set(
         'releases-verified',
         JSON.stringify({ latest: '1.0.0', all: ['1.0.0'], verifiedAt: Date.now() - 3 * 60 * 60 * 1000 - 1 }),
      );
      vi.stubGlobal(
         'fetch',
         vi.fn(async () => new Response(null, { status: 404 })),
      );
      github.failure = true;
      const response = await new App().fetch(
         new Request('https://example.org/v1.0.0/missing/'),
         env,
         {} as ExecutionContext,
         AppCachingStrategy.byPass,
      );
      expect(response.status).toBe(404);
      expect(put).not.toHaveBeenCalled();
   });

   it('rechecks persisted snapshots without a verification timestamp', async () => {
      values.set('releases-verified', JSON.stringify({ latest: '1.0.0', all: ['1.0.0'] }));
      github.release.tag_name = 'v2.0.0';
      expect((await releases.latest(env)).version).toBe('2.0.0');
      expect(put).not.toHaveBeenCalled();
   });
});
