import * as mime from 'mime-types';
import { basename } from 'path';
import { SemVer } from 'semver';
import { applyDefaultHeaders, Environment, oneHourInSeconds, oneMinuteInSeconds, oneYearInSeconds } from './common';
import { Releases } from './releases';
import { Router } from './router';

const ttlPreReleases = oneMinuteInSeconds * 15;
const ttlReleases = oneHourInSeconds;
const ttlUnique = oneYearInSeconds;
const ttlNotFound = oneMinuteInSeconds * 5;

const uniqueFilename = /^[a-zA-Z0-9]+\.[a-f0-9]{8,32}(?:\.min\.(?:js|css))$/;

export class PageHandler {
   public constructor(
      private router: Router,
      private releases: Releases
   ) {}

   public async handle(request: Request | undefined, env: Environment, path: string, versionOrPr?: SemVer | number): Promise<Response> {
      const latest = await this.releases.latest(env);

      if (request && versionOrPr && versionOrPr == latest) {
         return await this.router.redirect(request, path, 307);
      }
      if (!versionOrPr) {
         versionOrPr = latest;
      }

      const url = this._urlFor(env, path, versionOrPr);
      const cacheKey = new Request(url, {
         method: 'GET',
      });
      const cache = await caches.open('default');
      const preRelease = typeof versionOrPr === 'number' || (versionOrPr?.prerelease && versionOrPr.prerelease.length > 0);
      let filename = basename(url.pathname);
      const ttl = () => {
         if (uniqueFilename.exec(filename)) {
            return ttlUnique;
         }
         if (preRelease) {
            return ttlPreReleases;
         }
         return ttlReleases;
      };

      for (let run = 0; run < 10; run++) {
         const response = await cache.match(cacheKey);

         if (response) {
            // In case of HEAD we retrieved the body from the remote,
            // but should obviously not return this to the client.
            // So, we create a response without body.
            if (request && request.method === 'HEAD') {
               return new Response(null, response);
            }

            return response;
         }

         if (run === 0) {
            console.info(`Cache missed, need to retrieve it: ${url}...`);
         }

         let fetchedResponse = await fetch(url, {
            headers: {
               Authorization: this._authFor(env),
            },
         });

         if (fetchedResponse.status === 400 || fetchedResponse.status === 404) {
            // Try one more time with index.html suffix...
            const alternativeUrl = this._suffixUrlWith(url, 'index.html');
            fetchedResponse = await fetch(alternativeUrl, {
               headers: {
                  Authorization: this._authFor(env),
               },
            });
            if (fetchedResponse.status < 400) {
               filename = basename(alternativeUrl.pathname);
            }
         }

         if (fetchedResponse.status == 404 && request) {
            return await this.handleError(request, env, 404, 'Requested page not found.');
         }

         if (fetchedResponse.status >= 400) {
            // We'll never cache that problem, but just forward the result.
            console.error(`Cache missed, need to retrieve it: ${url}... FAILED (reason: ${fetchedResponse.status} - ${fetchedResponse.statusText})!`);
            return fetchedResponse;
         }

         const toCacheResponse = new Response(fetchedResponse.body, response);

         if (typeof versionOrPr === 'number') {
            toCacheResponse.headers.set('X-PR', `${versionOrPr}`);
         } else {
            toCacheResponse.headers.set('X-Version', `${versionOrPr}`);
         }
         toCacheResponse.headers.set('Cache-Control', `public, max-age=${ttl()}, public`);
         const mimeType = mime.lookup(filename);
         if (mimeType) {
            toCacheResponse.headers.set('Content-Type', mimeType.startsWith('text/') ? `${mimeType};charset=utf8` : mimeType);
         }
         applyDefaultHeaders(toCacheResponse);

         await cache.put(cacheKey, toCacheResponse);

         console.info(`Cache missed, need to retrieve it: ${url}... DONE (exists: ${fetchedResponse.status < 400})!`);
      }

      console.error(`Cache missed, need to retrieve it: ${url}... FAILED (reason: unknown)!`);
      return new Response(null, {
         status: 400,
      });
   }

   public async handleError(request: Request, env: Environment, statusCode: number, status: string, message?: string | undefined | null, headers?: HeadersInit): Promise<Response> {
      if (statusCode !== 404) {
         return await this._respondWithDefaultError(request, statusCode, status, headers);
      }

      const latest = await this.releases.latest(env);
      const url = this._urlFor(env, `/${statusCode}.html`, latest);

      const cacheKey = new Request(url, {
         method: 'GET',
      });
      const cache = await caches.open('default');

      for (let run = 0; run < 10; run++) {
         const response = await cache.match(cacheKey);

         if (response) {
            // In case of HEAD we retrieved the body from the remote,
            // but should obviously not return this to the client.
            // So, we create a response without body.
            const body = request.method === 'HEAD' ? null : response.body;

            const result = new Response(body, {
               headers: response.headers,
               status: statusCode,
               statusText: status,
            });

            if (message) {
               result.headers.set('X-Error-Details', message);
            }

            return result;
         }

         if (run === 0) {
            console.info(`Cache missed, need to retrieve it: ${url}...`);
         }

         const fetchedResponse = await fetch(url, {
            headers: {
               Authorization: this._authFor(env),
            },
         });

         if (fetchedResponse.status >= 400 && fetchedResponse.status !== 404) {
            // We'll never cache that problem, but just forward the result.
            console.error(`Cache missed, need to retrieve it: ${url}... FAILED (reason: ${fetchedResponse.status} - ${fetchedResponse.statusText})!`);
            return await this._respondWithDefaultError(request, statusCode, status, headers);
         }

         const toCacheResponse = new Response(fetchedResponse.body, response);

         toCacheResponse.headers.set('Cache-Control', `public, max-age=${ttlNotFound}, public`);
         toCacheResponse.headers.set('Content-Type', 'text/html;charset=utf8');
         applyDefaultHeaders(toCacheResponse);

         await cache.put(cacheKey, toCacheResponse);

         console.info(`Cache missed, need to retrieve it: ${url}... DONE (exists: ${fetchedResponse.status < 400})!`);
      }

      console.error(`Cache missed, need to retrieve it: ${url}... FAILED (reason: unknown)!`);
      return await this._respondWithDefaultError(request, statusCode, status, headers);
   }

   private async _respondWithDefaultError(request: Request, statusCode: number, status: string, headers?: HeadersInit): Promise<Response> {
      return await this.router.respondWithError(request, statusCode, status, `Cannot resolve default ${statusCode} error page, using default handler.`, headers);
   }

   private _authFor(env: Environment): string {
      const auth = btoa(`${env.GITHUB_ACCESS_USER}:${env.GITHUB_ACCESS_TOKEN}`);
      return `Basic ${auth}`;
   }

   private _urlFor(env: Environment, path: string, versionOrPr: SemVer | number): URL {
      const segment = typeof versionOrPr === 'number' ? `pr-${versionOrPr}` : `v${versionOrPr}`;
      return new URL(`https://raw.githubusercontent.com/${env.GITHUB_ORGANIZATION}/${env.GITHUB_REPOSITORY}/refs/tags/docs/${segment}${path}`);
   }

   private _suffixUrlWith(url: URL, suffix: string): URL {
      const copy = new URL(url.toString());
      if (!copy.pathname.endsWith('/')) {
         copy.pathname += '/';
      }
      copy.pathname += suffix;

      return copy;
   }
}
