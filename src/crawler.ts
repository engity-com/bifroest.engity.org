import { Octokit } from '@octokit/rest';
import type { SemVer } from 'semver';
import type { Environment } from './common';

export type ContentConsumer = (env: Environment, path: string, version: SemVer) => Promise<void>;

export class Crawler {
   public async crawl(env: Environment, version: SemVer, onEach: ContentConsumer): Promise<void> {
      const octokit = new Octokit({
         auth: env.GITHUB_ACCESS_TOKEN,
      });
      console.debug(`Crawling of ${version}...`);
      for await (const response of octokit.paginate.iterator(
         'GET /repos/{owner}/{repo}/git/trees/docs/v{version}?recursive=1',
         {
            owner: env.GITHUB_ORGANIZATION,
            repo: env.GITHUB_REPOSITORY,
            version: version.toString(),
            per_page: 100,
         },
      )) {
         for (const v of (<any>response.data).tree) {
            if (v.type !== 'blob') {
               continue;
            }

            if (!v.path) {
               continue;
            }

            await onEach(env, `/${v.path}`, version);
         }
      }
      console.log(`Crawling of ${version}... DONE!`);
   }
}
