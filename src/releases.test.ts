import type { KVNamespace } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from './common';
import { Contents } from './contents';
import { Releases } from './releases';
import { Router } from './router';
import { Versions } from './versions';

const github = vi.hoisted(() => ({
   release: { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-01-01' },
   refs: ['refs/tags/docs/v1.0.0', 'refs/tags/docs/v2.0.0'],
   failure: false,
}));

vi.mock('@octokit/rest', () => ({
   Octokit: class {
      request = async (route: string) => {
         if (route !== 'GET /repos/{owner}/{repo}/releases/latest') {
            throw new Error(`Unexpected GitHub endpoint: ${route}`);
         }
         if (github.failure) {
            throw new Error('GitHub unavailable');
         }
         return { data: github.release };
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
   const env = {
      KV: {
         get: async (key: string) => values.get(key) ?? null,
         put: async (key: string, value: string) => {
            values.set(key, value);
         },
      } as unknown as KVNamespace,
      GITHUB_ORGANIZATION: 'example',
      GITHUB_REPOSITORY: 'bifroest',
      GITHUB_ACCESS_USER: 'user',
      GITHUB_ACCESS_TOKEN: 'token',
   } as Environment;
   const releases = new Releases();

   beforeEach(() => {
      values.clear();
      github.release = { tag_name: 'v1.0.0', draft: false, prerelease: false, published_at: '2026-01-01' };
      github.refs = ['refs/tags/docs/v1.0.0', 'refs/tags/docs/v2.0.0'];
      github.failure = false;
      vi.stubGlobal(
         'fetch',
         vi.fn(async () => new Response('home', { status: 200 })),
      );
   });

   it("uses GitHub's manually selected older stable release, not the highest docs version", async () => {
      expect((await releases.update(env)).latest.version).toBe('1.0.0');
      const router = new Router(new Contents(releases), new Versions(releases));
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
      const router = new Router(new Contents(releases), new Versions(releases));
      const response = await router.handle(new Request(`https://example.org/v2.0.0-${suffix}/`), env);
      expect(response.headers.get('X-Version')).toBe(`2.0.0-${suffix}`);
      const payload = (await (
         await router.handle(new Request('https://example.org/versions.json'), env)
      ).json()) as Array<{
         title: string;
         aliases: Array<string>;
      }>;
      expect(payload.find(v => v.title === `2.0.0-${suffix}`)?.aliases).toEqual([]);
      expect(payload.find(v => v.aliases.includes('latest'))?.title).toBe('Latest (1.0.0)');
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
      await expect(releases.latest(env)).rejects.toThrow('GitHub unavailable');
   });
});
