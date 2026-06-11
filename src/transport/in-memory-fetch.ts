import { SempResponse } from '../semp/semp-router.js';

/**
 * Fetch interceptor serving the SEMP router in-process: requests to a
 * registered origin are answered directly; everything else falls through to
 * the platform fetch. Works in browsers and Node >= 18.
 */

export type HttpHandler = (method: string, pathname: string, bodyText: string) => SempResponse;

const endpoints = new Map<string, HttpHandler>();
let savedFetch: typeof fetch | undefined;
let installed = false;
let pinned = false;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function interceptingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(requestUrl(input), 'http://localhost');
  const handler = endpoints.get(`${url.protocol}//${url.host}`);
  if (!handler) {
    if (!savedFetch) throw new Error(`no in-memory endpoint for ${url.href} and no platform fetch`);
    return savedFetch(input as Request, init);
  }
  const method =
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
  let bodyText = '';
  if (init?.body != null) {
    if (typeof init.body === 'string') bodyText = init.body;
    else if (init.body instanceof Uint8Array) bodyText = new TextDecoder().decode(init.body);
    else if (init.body instanceof ArrayBuffer) {
      bodyText = new TextDecoder().decode(new Uint8Array(init.body));
    } else bodyText = String(init.body);
  } else if (typeof input === 'object' && 'text' in input) {
    bodyText = await input.text();
  }
  const result = handler(method.toUpperCase(), url.pathname, bodyText);
  return new Response(result.body, {
    status: result.status,
    headers: { 'content-type': result.contentType },
  });
}

function install(): void {
  if (installed) return;
  savedFetch = globalThis.fetch?.bind(globalThis);
  (globalThis as Record<string, unknown>)['fetch'] = interceptingFetch;
  installed = true;
}

function restore(): void {
  if (!installed || pinned) return;
  (globalThis as Record<string, unknown>)['fetch'] = savedFetch;
  installed = false;
}

/**
 * Eagerly installs the fetch interceptor and pins it (companion to
 * installWebSocketInterceptor; see that doc comment). With no endpoints
 * registered, every request passes through to the platform fetch.
 */
export function installFetchInterceptor(): void {
  pinned = true;
  install();
}

/** Registers an in-memory HTTP origin; returns an unregister function. */
export function registerInMemoryHttpEndpoint(url: string, handler: HttpHandler): () => void {
  const u = new URL(url);
  const key = `${u.protocol}//${u.host}`;
  if (endpoints.has(key)) throw new Error(`in-memory endpoint already registered for ${key}`);
  endpoints.set(key, handler);
  install();
  return () => {
    endpoints.delete(key);
    if (endpoints.size === 0) restore();
  };
}
