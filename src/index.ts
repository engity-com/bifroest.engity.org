import { ExportedHandler, Request, Response } from '@cloudflare/workers-types';
import { Environment } from './common';
import { Crawler } from './crawler';
import { PageHandler } from './handler_page';
import { VersionsHandler } from './handler_versions';
import { Releases } from './releases';
import { Router } from './router';

const router = new Router();
const releases = new Releases();

const versionHandler = new VersionsHandler(releases);
const pageHandler = new PageHandler(router, releases);
const crawler = new Crawler(pageHandler);

router.onDefault = async (request, env, path, versionOrPr?) => await pageHandler.handle(request, env, path, versionOrPr);
router.onNotFound = async (request: Request, env: Environment) => await pageHandler.handleError(request, env, 404, 'Requested resource not found.');
router.onVersions = async (request, env) => await versionHandler.handle(request, env);

export const handler = {
   async fetch(request: Request, env: Environment): Promise<Response> {
      return await router.handle(request, env);
   },
   async scheduled(_: ScheduledController, env: Environment): Promise<void> {
      await releases.update(env);
      const latest = await releases.latest(env);
      await crawler.crawlAndPreCache(env, latest);
   },
};

// noinspection JSUnusedGlobalSymbols
export default handler as ExportedHandler<Environment>;
