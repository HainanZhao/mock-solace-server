/**
 * Side-effect entry point: importing this module immediately patches
 * `globalThis.WebSocket` and `globalThis.fetch` with the in-memory
 * interceptors, before any later-listed import evaluates.
 *
 *   import 'mock-solace-server/browser/auto';   // must come first
 *   import solace from 'solclientjs';           // captures the fake — safe
 *
 * Use this when a library captures the WebSocket constructor at
 * module-evaluation time (the solclientjs browser build does), which would
 * otherwise force a dynamic `import('solclientjs')` after `server.start()`.
 * Best placed in a test-runner setup file (vitest `setupFiles`, Karma
 * `files`) so it is guaranteed to evaluate before any test module.
 *
 * Until a server is started, the patched globals pass everything through to
 * the platform implementations. The patch stays installed after
 * `server.stop()` (still passing through), so start/stop cycles behave
 * consistently across a test run.
 */
import { installFetchInterceptor } from './transport/in-memory-fetch.js';
import { installWebSocketInterceptor } from './transport/in-memory-ws.js';

installWebSocketInterceptor();
installFetchInterceptor();

export {};
