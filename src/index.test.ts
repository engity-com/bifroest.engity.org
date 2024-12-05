import { ExecutionContext, KVNamespace } from '@cloudflare/workers-types';
import { AppCachingStrategy } from './app';
import { Environment } from './common';
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
   // @ts-ignore
   getWithMetadataetadata() {
      throw `Not implemented!`;
   },
};

const testCtx: ExecutionContext = {
   passThroughOnException(): void {
      throw `Not implemented!`;
   },
   waitUntil(): void {
      throw `Not implemented!`;
   },
};

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

test('GET /', async () => {
   const result = await handler.fetch(new Request('http://falcon/latest/', { method: 'GET' }), testEnvironment, testCtx, AppCachingStrategy.byPass);
   expect(result.status).toBe(301);
   expect(result.headers.get('Location')).toBe('http://falcon/');
});
