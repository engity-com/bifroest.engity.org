import {KVNamespace} from '@cloudflare/workers-types';

export interface Environment {
   GITHUB_ACCESS_USER: string;
   GITHUB_ACCESS_TOKEN: string;
   GITHUB_ORGANIZATION: string;
   GITHUB_REPOSITORY: string;
   KV: KVNamespace;
   ACCOUNT_ID: string;
   PROJECT_NAME: string;
   PROJECT_DOMAIN?: string;
   API_TOKEN: string;
}

export type Url = string;

export const applyDefaultHeaders = (target: Response) => {
   target.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
   target.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
   target.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
   target.headers.set('X-Content-Type-Options', 'nosniff');
   target.headers.set('X-Frame-Options', 'SAMEORIGIN');
   target.headers.set('X-Xss-Protection', '1; mode=block');
   target.headers.set('Strict-Transport-Security', `max-age=${oneYearInSeconds}`);
}

export const oneMinuteInSeconds = 60;
export const oneHourInSeconds = oneMinuteInSeconds * 60;
export const oneDayInSeconds = oneHourInSeconds * 24;
export const oneYearInSeconds = oneDayInSeconds * 365;
