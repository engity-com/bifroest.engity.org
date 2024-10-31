import { Octokit } from '@octokit/rest';
import { SemVer } from 'semver';
import { Environment } from './common';
import { PageHandler } from './handler_page';

export class Crawler {
   public constructor(private pageHandler: PageHandler) {}

   public async crawlAndPreCache(env: Environment, version: SemVer): Promise<void> {
      const octokit = new Octokit({
         auth: env.GITHUB_ACCESS_TOKEN,
      });
      console.log(`Pre caching of ${version}...`);
      for await (const response of octokit.paginate.iterator('GET /repos/{owner}/{repo}/git/trees/docs/v{version}?recursive=1', {
         owner: env.GITHUB_ORGANIZATION,
         repo: env.GITHUB_REPOSITORY,
         version: version.toString(),
         per_page: 100,
      })) {
         // @ts-ignore
         for (const v of response.data.tree) {
            // @ts-ignore
            const type = v.type as string | undefined;
            if (type !== 'blob') {
               continue;
            }

            // @ts-ignore
            const path = v.path as string | undefined;
            if (!path) {
               continue;
            }

            await this.pageHandler.handle(undefined, env, `/${path}`, version);
         }
      }
      console.log(`Pre caching of ${version}... DONE!`);
   }
}
