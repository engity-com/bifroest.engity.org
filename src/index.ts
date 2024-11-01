import {ExportedHandler, Request, Response, ScheduledController} from '@cloudflare/workers-types';
import {Environment} from './common';
import {PageHandler} from './handler_page';
import {VersionsHandler} from './handler_versions';
import {Releases} from './releases';
import {Router} from './router';

const router = new Router();
const releases = new Releases();
const versionHandler = new VersionsHandler(releases);
const pageHandler = new PageHandler(router, releases);

router.onDefault = async (request, env, path, version?) => await pageHandler.handle(request, env, path, version);
router.onNotFound = async (request: Request, env: Environment) => await pageHandler.handleError(request, env, 404, 'Requested resource not found.');
router.onVersions = async (request, env) => await versionHandler.handle(request, env);

export const handler = {
   async fetch(request: Request, env: Environment): Promise<Response> {
      return await router.handle(request, env);
   },
   async scheduled(_: ScheduledController, env: Environment): Promise<void> {
      // TODO! Pre cache?
   },
};

// noinspection JSUnusedGlobalSymbols
export default handler as ExportedHandler<Environment>;
