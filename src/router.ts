import {SemVer} from 'semver';
import semver from 'semver/preload';
import {Environment} from './common';

interface Rule {
   regexp: RegExp;
   handler: (request: Request, env: Environment, match: RegExpMatchArray) => Promise<Response>;
}

export class Router {
   private readonly _rules: Array<Rule> = [
      {
         regexp: /^\/versions.json$/,
         handler: async (request, env, match) => await this.onVersions(request, env),
      },
      {
         regexp: /^\/(v\d\.\d\.\d[^/]*)(|\/.*)$/,
         handler: async (request, env, match) => await this._onVersioned(request, env, match[1], match[2]),
      },
      {
         regexp: /^\/latest(|\/.*)$/,
         handler: async (request, _, match) => await this.redirect(request, match[1], 301),
      },
   ];

   public onDefault: (request: Request, env: Environment, path: string, version?: SemVer) => Promise<Response> = async (request, env, path, version) => {
      console.log(`fallback.onDefault(url="${request.url}", path="${path}", version: "${version}")`);
      return await this.onNotFound(request, env);
   };

   public onVersions: (request: Request, env: Environment) => Promise<Response> = async (request, env) => {
      console.log(`fallback.onVersions(url="${request.url}")`);
      return await this.onNotFound(request, env);
   };

   public onNotFound: (request: Request, env: Environment) => Promise<Response> = async (request) => {
      return await this.respondWithError(request, 404, 'Not found', 'The resource you requested cannot be found.');
   };

   public async handle(request: Request, env: Environment): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
         return await this.respondWithError(request, 405, 'Method not allowed', `The request method ${request.method} is not allowed for this resource.`);
      }

      const url = new URL(request.url);
      const { pathname } = url;

      for (const rule of this._rules) {
         const match = pathname.match(rule.regexp);
         if (match) {
            return rule.handler(request, env, match);
         }
      }

      return await this.onDefault(request, env, pathname);
   }

   private async _onVersioned(request: Request, env: Environment, rawVersion: string, restPath: string): Promise<Response> {
      const version = semver.coerce(rawVersion, { includePrerelease: true });
      if (!version) {
         const url = new URL(request.url);
         return await this.onDefault(request, env, url.pathname);
      }

      return await this.onDefault(request, env, restPath, version);
   };

   public async redirect(request: Request, newPath: string, status: number): Promise<Response> {
      const url = new URL(request.url);
      url.pathname = newPath;
      return Response.redirect(url.toString(), status);
   }

   public async respondWithError(_: Request, statusCode: number, status: string, message: string, headers: HeadersInit = {}) {
      const targetHeaders = new Headers(headers);
      targetHeaders.append(`X-Error-Details`, message);
      return new Response(null, {
         status: statusCode,
         statusText: status,
         headers: targetHeaders,
      });
   }
}
