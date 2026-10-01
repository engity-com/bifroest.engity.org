import type { ExecutionContext, KVNamespace } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { AppCachingStrategy } from './app';
import type { Environment } from './common';
import { handler } from './index';

const testKv: KVNamespace = {
   put() {
      throw `Not implemented!`;
   },
   get() {
      throw `Not implemented!`;
   },
   list() {
      throw `Not implemented!`;
   },
   delete() {
      throw `Not implemented!`;
   },
   getWithMetadata() {
      throw `Not implemented!`;
   },
};

const testCtx = {
   passThroughOnException(): void {
      throw `Not implemented!`;
   },
   waitUntil(): void {
      throw `Not implemented!`;
   },
   props: undefined,
} as unknown as ExecutionContext;

const testEnvironment: Environment = {
   GITHUB_ACCESS_USER: 'testGithubAccessUser',
   GITHUB_ACCESS_TOKEN: 'testGithubAccessToken',
   GITHUB_ORGANIZATION: 'testGithubOrganization',
   GITHUB_REPOSITORY: 'testGithubRepository',
   KV: testKv,
   ASSETS: {
      fetch() {
         throw `Not implemented!`;
      },
   },
};

describe('handler', () => {
   describe('fetch()', () => {
      it('should handle GET /latest/ and redirect temporarily to /', async () => {
         const result = await handler.fetch(
            new Request('http://falcon/latest/', { method: 'GET' }),
            testEnvironment,
            testCtx,
            AppCachingStrategy.byPass,
         );
         expect(result.status).toBe(307);
         expect(result.headers.get('Location')).toBe('http://falcon/');
         expect(result.headers.get('Cache-Control')).toBe('public, max-age=300');
      });
   });
});
