import { SemVer } from 'semver';
import semver from 'semver/preload';
import { Environment } from './common';
import { Contents } from './contents';
import { Versions } from './versions';

interface Rule {
   regexp: RegExp;
   handler: (request: Request, env: Environment, match: RegExpMatchArray) => Promise<Response>;
}

export class Router {
   private readonly _rules: Array<Rule> = [
      {
         regexp: /^\/versions.json$/,
         handler: async (request, env) => await this.onVersions(request, env),
      },
      {
         regexp: /^\/(v\d+\.\d+\.\d+[^/]*)(|\/.*)$/,
         handler: async (request, env, match) => await this._onVersioned(request, env, match[1], match[2]),
      },
      {
         regexp: /^\/pr-(\d+)(|\/.*)$/,
         handler: async (request, env, match) => await this._onPr(request, env, parseInt(match[1]), match[2]),
      },
      {
         regexp: /^\/(\d+\.\d+\.\d+)(|\/.*)$/,
         handler: async (request, env, match) => await this.redirect(request, `v${match[1]}${match[2]}`, 301),
      },
      {
         regexp: /^\/latest(|\/.*)$/,
         handler: async (request, _, match) => await this.redirect(request, match[1], 301),
      },
   ];

   public constructor(
      private readonly contents: Contents,
      private readonly versions: Versions
   ) {}

   private async onDefault(request: Request, env: Environment, path: string, versionOrPr?: SemVer | number) {
      return await this.contents.serve(request, env, this, path, versionOrPr);
   }

   private async onVersions(request: Request, env: Environment) {
      return await this.versions.serve(request, env);
   }

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
   }

   private async _onPr(request: Request, env: Environment, prNumber: number, restPath: string): Promise<Response> {
      return await this.onDefault(request, env, restPath, prNumber);
   }

   public async redirect(request: Request, newPath: string, status: number): Promise<Response> {
      const url = new URL(request.url);
      url.pathname = newPath;
      return Response.redirect(url.toString(), status);
   }

   public async respondWithError(_: Request, statusCode: number, status: string | undefined, message: string, headers: HeadersInit = {}) {
      const targetHeaders = new Headers(headers);
      targetHeaders.append(`X-Error-Details`, message);
      return new Response(null, {
         status: statusCode,
         statusText: status,
         headers: targetHeaders,
      });
   }
}
