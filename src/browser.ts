/**
 * Browser entry point: everything except the Node socket server. Import as
 * `mock-solace-server/browser`. InMemorySolaceServer also works in Node
 * (e.g. for testing browser bundles under vitest).
 */
export { InMemorySolaceServer } from './in-memory-server.js';
export { installWebSocketInterceptor } from './transport/in-memory-ws.js';
export { installFetchInterceptor } from './transport/in-memory-fetch.js';
export type { ServerAddresses } from './server-core.js';
export { SolaceServerCore } from './server-core.js';
export type { MockSolaceServerOptions, CredentialCheck } from './config.js';
export type { CapturedMessage, ClientInfo, ServerEvents } from './api/events.js';
export { TopicTrie, validateSubscription, InvalidSubscriptionError } from './broker/topic-matcher.js';
export { Queue } from './broker/queue.js';
export type { QueueProperties, StoredMessage } from './broker/queue.js';
export { Responder, ScenarioBuilder } from './broker/mock-service.js';
export type {
  Payload,
  ResponderHandler,
  ResponderOptions,
  ServiceRequest,
} from './broker/mock-service.js';
