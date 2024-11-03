import { ExecutionContext, ExportedHandler } from '@cloudflare/workers-types';
import { Cache } from './cache';
import { Environment } from './common';
import { Contents } from './contents';
import { Crawler } from './crawler';
import { Releases } from './releases';
import { Router } from './router';
import { Versions } from './versions';

export enum AppCachingStrategy {
   automatic,
   byPass,
   refreshAlways,
}

export class App implements ExportedHandler<Environment> {
   private readonly cache = new Cache();
   private readonly releases = new Releases();
   private readonly contents = new Contents(this.releases);
   private readonly versions = new Versions(this.releases);
   private readonly router = new Router(this.contents, this.versions);
   private readonly crawler = new Crawler();

   public async fetch(request: Request, env: Environment, ctx: ExecutionContext, cachingStrategy: AppCachingStrategy = AppCachingStrategy.automatic): Promise<Response> {
      switch (request.method) {
         case 'GET':
         case 'HEAD':
            break;
         default:
            return await this.router.respondWithError(request, 405, 'Method not allowed.', `Method passThroughOnException${request.method} is not allowed.`);
      }
      return await this.fetchInternal(request, env, ctx, cachingStrategy);
   }

   public async scheduled(_: ScheduledController, env: Environment, ctx: ExecutionContext): Promise<void> {
      await this.preCache(env, ctx);
   }

   private async fetchInternal(request: Request, env: Environment, ctx: ExecutionContext, cachingStrategy: AppCachingStrategy = AppCachingStrategy.automatic): Promise<Response> {
      switch (cachingStrategy) {
         case AppCachingStrategy.automatic:
         case AppCachingStrategy.refreshAlways:
            return await this.cache.handle(request, env, ctx, (request, env) => this.router.handle(request, env), cachingStrategy === AppCachingStrategy.refreshAlways);
         case AppCachingStrategy.byPass:
            return await this.router.handle(request, env);
         default:
            throw `Don't know how to handle cachingStrategy ${cachingStrategy}`;
      }
   }

   private async preCache(env: Environment, ctx: ExecutionContext): Promise<void> {
      const latest = await this.releases.update(env);
      await this.crawler.crawl(env, latest, async (env, path) => {
         const url = new URL(`https://bifroest.engity.org${path}`);
         const request = new Request(url, {
            method: 'GET',
         });
         await this.fetchInternal(request, env, ctx, AppCachingStrategy.refreshAlways);
      });
   }
}
