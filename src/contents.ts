import { basename } from 'node:path';
import * as mime from 'mime-types';
import { SemVer } from 'semver';
import {
   applyDefaultHeaders,
   type Environment,
   oneHourInSeconds,
   oneMinuteInSeconds,
   oneYearInSeconds,
} from './common';
import type { Releases } from './releases';

const ttlPreReleases = oneMinuteInSeconds * 15;
const ttlReleases = oneHourInSeconds * 12;
const ttlUnique = oneYearInSeconds;
const ttlNotFound = oneMinuteInSeconds * 5;

const uniqueFilename = /^[a-zA-Z0-9]+\.[a-f0-9]{8,32}\.min\.(?:js|css)$/;

export interface FallbackHandler {
   redirect(request: Request, newPath: string, status: number): Promise<Response>;
   respondWithError(
      request: Request,
      statusCode: number,
      status: string | undefined,
      message: string,
      headers?: HeadersInit,
   ): Promise<Response>;
}

export class Contents {
   public constructor(private releases: Releases) {}

   public async serve(
      request: Request,
      env: Environment,
      fallback: FallbackHandler,
      path: string,
      versionOrPr?: SemVer | number,
   ): Promise<Response> {
      const latest = await this.releases.latest(env);

      if (request && versionOrPr && versionOrPr === latest) {
         return await fallback.redirect(request, path, 307);
      }
      if (!versionOrPr) {
         versionOrPr = latest;
      }

      const url = this._urlFor(env, path, versionOrPr);
      const preRelease =
         typeof versionOrPr === 'number' || (versionOrPr?.prerelease && versionOrPr.prerelease.length > 0);
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

      let fetchedResponse = await fetch(url, {
         headers: {
            Authorization: this._authFor(env),
         },
      });

      if (fetchedResponse.status === 400 || fetchedResponse.status === 404) {
         // Try one more time with index.html suffix...
         const alternativeUrl = this._suffixUrlWith(url, 'index.html');
         const alternativeResponse = await fetch(alternativeUrl, {
            headers: {
               Authorization: this._authFor(env),
            },
         });
         if (alternativeResponse.status < 400) {
            if (request && !path.endsWith('/')) {
               let targetPath = `${path}/`;
               if (typeof versionOrPr === 'number') {
                  targetPath = `pr-${versionOrPr}${targetPath}`;
               }
               if (versionOrPr instanceof SemVer) {
                  targetPath = `v${versionOrPr}${targetPath}`;
               }
               return await fallback.redirect(request, targetPath, 307);
            }
            filename = basename(alternativeUrl.pathname);
            fetchedResponse = alternativeResponse;
         }
      }

      let status = fetchedResponse.status;
      if (status >= 400 && request) {
         if (status === 400) {
            status = 404;
         }
         return await this.serveError(request, env, fallback, status);
      }

      const response = new Response(fetchedResponse.body, {
         status: 200,
      });

      const eTag = fetchedResponse.headers.get('ETag');
      if (eTag) {
         response.headers.set('ETag', eTag);
      }
      const lastModified = fetchedResponse.headers.get('Last-Modified');
      if (lastModified) {
         response.headers.set('Last-Modified', lastModified);
      }

      if (typeof versionOrPr === 'number') {
         response.headers.set('X-PR', `${versionOrPr}`);
      } else {
         response.headers.set('X-Version', `${versionOrPr}`);
      }
      response.headers.set('Cache-Control', `public, max-age=${ttl()}, public`);
      const mimeType = mime.lookup(filename);
      if (mimeType) {
         response.headers.set('Content-Type', mimeType.startsWith('text/') ? `${mimeType};charset=utf8` : mimeType);
      }
      applyDefaultHeaders(response);

      return response;
   }

   public async serveError(
      request: Request,
      env: Environment,
      fallback: FallbackHandler,
      statusCode: number,
      status?: string | undefined,
      _message?: string | undefined | null,
      headers?: HeadersInit,
   ): Promise<Response> {
      const latest = await this.releases.latest(env);
      const url = this._urlFor(env, `/${statusCode}.html`, latest);

      const fetchedResponse = await fetch(url, {
         headers: {
            Authorization: this._authFor(env),
         },
      });

      if (fetchedResponse.status >= 400) {
         return await fallback.respondWithError(
            request,
            statusCode,
            status,
            `Cannot resolve default ${statusCode} error page, using default handler.`,
            headers,
         );
      }

      const response = new Response(fetchedResponse.body, {
         status: statusCode,
         statusText: status,
      });

      response.headers.set('Cache-Control', `public, max-age=${ttlNotFound}, public`);
      response.headers.set('Content-Type', 'text/html;charset=utf8');
      applyDefaultHeaders(response);

      return response;
   }

   private _authFor(env: Environment): string {
      const auth = btoa(`${env.GITHUB_ACCESS_USER}:${env.GITHUB_ACCESS_TOKEN}`);
      return `Basic ${auth}`;
   }

   private _urlFor(env: Environment, path: string, versionOrPr: SemVer | number): URL {
      const segment = typeof versionOrPr === 'number' ? `pr-${versionOrPr}` : `v${versionOrPr}`;
      return new URL(
         `https://raw.githubusercontent.com/${env.GITHUB_ORGANIZATION}/${env.GITHUB_REPOSITORY}/refs/tags/docs/${segment}${path}`,
      );
   }

   private _suffixUrlWith(url: URL | string, suffix: string): URL {
      const copy = new URL(url.toString());
      if (!copy.pathname.endsWith('/')) {
         copy.pathname += '/';
      }
      copy.pathname += suffix;

      return copy;
   }
}
