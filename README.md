# mock-solace-server

A **mock Solace PubSub+ broker** for testing environments. It speaks the real
SMF binary wire protocol over WebSocket, so the official
[`solclientjs`](https://www.npmjs.com/package/solclientjs) SDK connects to it
**unmodified** — no test doubles, no SDK shims.

Built for test suites:

- **In-memory and fast** — starts in milliseconds on ephemeral ports, safe for
  parallel test workers.
- **Runs in the browser too** — an MSW-style in-memory mode patches
  `WebSocket`/`fetch` so the solclientjs browser build connects with no
  network and no Node server (vitest browser mode, Karma, Storybook).
- **Topic routing first-class** — full Solace wildcard semantics (`*`, `abc*`,
  `>`), property-tested against a reference matcher.
- **Mock services built in** — stub the *other side* of the broker: answer
  `session.sendRequest()` request/reply, publish broker-originated messages,
  and replay named message scenarios with `server.play('name')`.
- **Inspection hooks** — captured messages, connected clients, typed events,
  `waitForMessage()` for assertions.
- **Queues + SEMP v2** — queue spooling, guaranteed-messaging consumers
  (happy path), and a minimal SEMP v2 API so real provisioning code works.

## Contents

- [Quick start](#quick-start)
- [Browser and in-memory mode](#browser-and-in-memory-mode)
  - [Import order is load-bearing](#import-order-is-load-bearing)
- [What's implemented](#whats-implemented)
- [Usage guide](#usage-guide)
  - [Publish / subscribe with wildcards](#publish--subscribe-with-wildcards)
  - [Queues and guaranteed-messaging consumers](#queues-and-guaranteed-messaging-consumers)
  - [Mock services: request/reply stubs](#mock-services-requestreply-stubs)
  - [Mock services: broker-originated publishing and replayable scenarios](#mock-services-broker-originated-publishing-and-replayable-scenarios)
  - [Using it in vitest / jest](#using-it-in-vitest--jest)
  - [Inspection and events](#inspection-and-events)
  - [Simulating failures](#simulating-failures)
  - [Configuration options](#configuration-options)
- [SEMP v2 endpoints](#semp-v2-endpoints)
- [How protocol fidelity is maintained](#how-protocol-fidelity-is-maintained)
- [Development](#development)

## Requirements

- Node.js >= 22 for the socket server (`MockSolaceServer`)
- Any evergreen browser (or Node) for the in-memory mode
  (`mock-solace-server/browser`)

## Quick start

```ts
import { MockSolaceServer } from 'mock-solace-server';
import solace from 'solclientjs';

const server = new MockSolaceServer();           // ephemeral ports by default
const { smfWsUrl, sempUrl } = await server.start();

// Point any solclientjs session at the mock:
const session = solace.SolclientFactory.createSession(
  new solace.SessionProperties({
    url: smfWsUrl,                               // e.g. ws://127.0.0.1:54321
    vpnName: 'default',
    userName: 'any',
    password: 'any',
  }),
);
session.connect();                               // reaches UP_NOTICE

// ... subscribe / publish with the real SDK as usual ...

await server.stop();
```

To run on Solace's conventional ports instead:

```ts
new MockSolaceServer({ smfWsPort: 8008, sempPort: 8080 });
```

There is a runnable end-to-end demo in [`examples/pubsub.mjs`](examples/pubsub.mjs)
(`npm run build && node examples/pubsub.mjs`).

## Browser and in-memory mode

`MockSolaceServer` binds real sockets and is Node-only. For tests that run
*inside a browser* — vitest browser mode, Karma, Storybook, or just a dev
page — use `InMemorySolaceServer` from the `/browser` entry point. Like
[MSW](https://mswjs.io), it intercepts the network API itself: `start()`
patches `globalThis.WebSocket` (and `fetch`, for SEMP), so the unmodified
solclientjs **browser build** connects straight into the broker core with no
network, no ports, and no separate process.

```ts
import 'mock-solace-server/browser/auto'; // ① patches WebSocket/fetch — keep this import FIRST
import solace from 'solclientjs';         // ② captures the patched WebSocket
import { InMemorySolaceServer } from 'mock-solace-server/browser';

const server = new InMemorySolaceServer();
const { smfWsUrl, sempUrl } = await server.start();

// From here everything works exactly like the Node quick start:
// createSession({ url: smfWsUrl, ... }), subscribe, publish, sendRequest...
// SEMP provisioning code can fetch(sempUrl + '/SEMP/v2/...') as usual.

await server.stop();
```

### Import order is load-bearing

solclientjs's browser build captures the `WebSocket` constructor **when its
module evaluates**, not when you connect. The interceptor must therefore be
installed before solclientjs is imported. There are two ways to guarantee
that, pick one:

1. **The `/auto` entry (recommended).** A bare side-effect import that
   patches `WebSocket`/`fetch` immediately. ES modules evaluate dependencies
   in declaration order, so listing it before `solclientjs` is sufficient —
   but safest is a test-runner setup file, which always evaluates before any
   test module:

   ```ts
   // vitest.config.ts
   export default defineConfig({
     test: { setupFiles: ['mock-solace-server/browser/auto'] },
   });
   // Karma: list a bootstrap file that imports it first in `files`.
   ```

   Beware of tooling that reorders imports: if a formatter or an
   auto-organize-imports rule can move the bare import below `solclientjs`,
   prefer the setup-file form.

   Until a server is started — and again after `server.stop()` — the patched
   globals pass everything through to the platform implementations, so the
   `/auto` import is inert for non-mock traffic. Connections to origins
   without a registered in-memory endpoint always fall through, patched or
   not.

2. **Dynamic import, no `/auto`.** `start()` also installs the interceptors,
   so loading solclientjs lazily after it works without the side-effect
   entry, and `stop()` then fully restores the globals:

   ```ts
   import { InMemorySolaceServer } from 'mock-solace-server/browser';

   const server = new InMemorySolaceServer();
   const { smfWsUrl } = await server.start();
   const solace = (await import('solclientjs')).default; // AFTER start()
   ```

Both interceptors can also be installed programmatically via
`installWebSocketInterceptor()` / `installFetchInterceptor()` from
`mock-solace-server/browser`.

Notes:

- The whole test is **one process**, so the full server API
  (`server.publish()`, `respondTo()`, `scenario()`, `waitForMessage()`,
  `capturedMessages()`, queues) is directly available next to your
  assertions — no control channel needed.
- The returned URLs use a synthetic host like `ws://mock-solace-1.invalid:55555`;
  nothing listens there. The interceptor recognizes the origin and routes
  in-memory. WebSocket/fetch calls to **other** origins fall through to the
  real implementations untouched.
- `InMemorySolaceServer` also works in Node — but note the solclientjs *Node*
  build bundles its own `ws` client and ignores `globalThis.WebSocket`, so it
  can't be intercepted. In Node, either use the socket-based
  `MockSolaceServer`, or load the browser build explicitly
  (`require('solclientjs/lib-browser/solclient.js')`), which is exactly what
  [`test/integration/in-memory.test.ts`](test/integration/in-memory.test.ts)
  does.
- This is the same trade-off MSW makes: its browser HTTP mocking rides a
  Service Worker (a real network-layer hook, immune to import order), but
  service workers cannot intercept WebSockets, so MSW's own WebSocket support
  patches the global class exactly like this — with the same
  install-before-capture requirement.

## What's implemented

| Area | Status |
|---|---|
| SMF over WebSocket (subprotocol `smf.solacesystems.com`) | ✅ |
| In-memory browser mode (MSW-style WebSocket/fetch interception) | ✅ |
| ClientCtrl login handshake, keepalives, clean disconnect | ✅ |
| SMP subscribe/unsubscribe with confirmations | ✅ |
| Direct message routing (TrMsg), SDT payloads pass through intact | ✅ |
| Solace wildcards: `*`, `abc*` prefix, trailing `>` | ✅ (property-tested) |
| Multiple message VPNs (auto-created on login by default) | ✅ |
| Queues + queue topic subscriptions (spooling) | ✅ |
| Broker-side mock services: request/reply stubs, publish, scenarios | ✅ |
| SEMP v2: msgVpns, queue CRUD, queue subscriptions, monitor msgs | ✅ minimal |
| Guaranteed messaging consumer flows (AssuredCtrl) | minimal happy path |
| Raw TCP SMF (port 55555), compression, TLS, transactions, replay | ❌ out of scope |

## Usage guide

All examples below use the real `solclientjs` SDK against a started mock.
Initialize the SDK factory once per process:

```ts
import solace from 'solclientjs';

solace.SolclientFactory.init(
  new solace.SolclientFactoryProperties({
    profile: solace.SolclientFactoryProfiles.version10_5,
  }),
);
```

### Publish / subscribe with wildcards

```ts
const server = new MockSolaceServer();
const { smfWsUrl } = await server.start();

const subscriber = solace.SolclientFactory.createSession(
  new solace.SessionProperties({ url: smfWsUrl, vpnName: 'default', userName: 'u', password: 'p' }),
);
await new Promise<void>((resolve, reject) => {
  subscriber.on(solace.SessionEventCode.UP_NOTICE, resolve);
  subscriber.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, reject);
  subscriber.connect();
});

subscriber.on(solace.SessionEventCode.MESSAGE, (msg) => {
  console.log(msg.getDestination().getName(), msg.getBinaryAttachment());
});

// Solace wildcards work exactly as on a real broker:
//   orders/*/created   -> one level between 'orders' and 'created'
//   orders/eu*/created -> level starting with 'eu'
//   orders/>           -> one or more levels under 'orders'
await new Promise<void>((resolve, reject) => {
  subscriber.on(solace.SessionEventCode.SUBSCRIPTION_OK, () => resolve());
  subscriber.on(solace.SessionEventCode.SUBSCRIPTION_ERROR, reject);
  subscriber.subscribe(
    solace.SolclientFactory.createTopicDestination('orders/>'),
    true,           // request confirmation
    'my-corr-key',
    5000,
  );
});

// Publish from any session (here: the same one).
const msg = solace.SolclientFactory.createMessage();
msg.setDestination(solace.SolclientFactory.createTopicDestination('orders/eu/created'));
msg.setBinaryAttachment(JSON.stringify({ id: 42 }));
msg.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
subscriber.send(msg);
```

### Queues and guaranteed-messaging consumers

Provision a queue (programmatically or via SEMP), then consume with the SDK's
`MessageConsumer`:

```ts
// Queue subscribed to a topic — matching published messages are spooled.
server.createQueue('q/orders', { topics: ['orders/>'] });

const consumer = session.createMessageConsumer({
  queueDescriptor: { name: 'q/orders', type: solace.QueueType.QUEUE },
  acknowledgeMode: solace.MessageConsumerAcknowledgeMode.CLIENT,
});

consumer.on(solace.MessageConsumerEventName.UP, () => console.log('flow up'));
consumer.on(solace.MessageConsumerEventName.MESSAGE, (msg) => {
  console.log('from queue:', msg.getBinaryAttachment());
  msg.acknowledge();              // removes the message from the mock's spool
});
consumer.connect();
```

Semantics matching a real broker (happy path):

- Messages published to a matching topic **before** the consumer binds are
  spooled and delivered on bind.
- Unacknowledged messages survive consumer disconnect and are **redelivered**
  with `msg.isRedelivered() === true`.
- Binding to a nonexistent queue fails the consumer with
  `CONNECT_FAILED_ERROR`.

Note: publish messages with `DIRECT` delivery mode (publisher guaranteed flows
are not implemented; queue ingress happens via topic subscriptions).

### Mock services: request/reply stubs

Real systems usually have a service on the other side of the broker. Instead
of running one in your tests, register it **inside** the mock — a virtual
responder that participates in topic routing and answers
`session.sendRequest()` calls from the client under test:

```ts
// Computed replies — handler gets the decoded request:
const responder = server.respondTo('svc/users/*', (req) => {
  const id = req.topic.split('/').pop();
  return { id, name: `user-${id}` };          // string | Buffer | object (JSON)
});

// Static replies:
server.respondTo('svc/ping', 'pong');

// Async handlers work too:
server.respondTo('svc/orders/create', async (req) => {
  await somethingAsync();
  return { ok: true, received: req.payload.toString() };
});

// Return null/undefined to NOT reply — the client's request times out,
// which is exactly how a missing service fails in production:
server.respondTo('svc/down', () => null);
```

The client under test needs no changes — plain SDK request/reply:

```ts
const msg = solace.SolclientFactory.createMessage();
msg.setDestination(solace.SolclientFactory.createTopicDestination('svc/users/42'));
msg.setBinaryAttachment('hi');
session.sendRequest(msg, 5000, (s, reply) => {
  console.log(reply.getBinaryAttachment());   // {"id":"42","name":"user-42"}
});
```

Responders also receive plain published messages matching their subscription
(no reply is sent when there is no reply-to), capture everything for
assertions, and can be detached:

```ts
responder.requests;                  // every request seen: topic, payload, correlationId
responder.requests[0].payload.toString();
responder.remove();                  // service "goes down" mid-test
```

### Mock services: broker-originated publishing and replayable scenarios

Publish straight from the server — no publisher session needed:

```ts
server.publish('market/prices/EURUSD', { bid: 1.0842, ask: 1.0844 });
```

For multi-message flows, register a named scenario once and replay it
whenever a test needs that traffic:

```ts
server.scenario('order-lifecycle', (s) =>
  s.publish('orders/created', { id: 1 })
   .wait(50)                                  // ms between messages
   .publish('orders/paid',    { id: 1 })
   .publish('orders/shipped', { id: 1 }),
);

// In a test — replay as many times as you like:
await server.play('order-lifecycle');
```

`play()` resolves after the last step, so you can await it and then assert on
what your client received.

### Using it in vitest / jest

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MockSolaceServer } from 'mock-solace-server';

let server: MockSolaceServer;
let url: string;

beforeAll(async () => {
  server = new MockSolaceServer();          // port 0 = ephemeral, safe for parallel workers
  ({ smfWsUrl: url } = await server.start());
  // hand `url` to the code under test, e.g. via env or DI
});

afterAll(async () => {
  await server.stop();
});

it('publishes an order event', async () => {
  await myApp.placeOrder({ id: 42 });       // app code using solclientjs internally

  const msg = await server.waitForMessage((m) => m.topic === 'orders/created');
  expect(JSON.parse(msg.payload.toString())).toMatchObject({ id: 42 });
});
```

### Inspection and events

```ts
const server = new MockSolaceServer({
  vpns: ['default', 'other'],
  validateCredentials: ({ username, password }) => username === 'svc' && password === 's3cret',
});

server.clients();                  // connected clients + their subscriptions
server.capturedMessages();         // every published message (topic, payload, publisher, fan-out count)
server.clearCapturedMessages();
await server.waitForMessage((m) => m.topic === 'orders/created', 5000);

server.createQueue('q/orders', { topics: ['orders/>'] });
server.getQueue('q/orders')!.messages;   // spooled messages
server.deleteQueue('q/orders');

server.on('clientConnected', (client) => {});
server.on('clientDisconnected', (client) => {});
server.on('subscriptionAdded', (client, subscription) => {});
server.on('subscriptionRemoved', (client, subscription) => {});
server.on('messagePublished', (message) => {});
server.on('messageDiscarded', (message, reason) => {});
```

### Simulating failures

```ts
// Reject logins (drives CONNECT_FAILED_ERROR in the client under test):
new MockSolaceServer({
  validateCredentials: () => false,                       // 401 Unauthorized
});
new MockSolaceServer({
  validateCredentials: () => ({ code: 403, text: 'Forbidden' }),
});

// Reject unknown VPNs instead of auto-creating them:
new MockSolaceServer({ vpns: ['prod-vpn'], autoCreateVpns: false });

// Simulate a broker outage mid-test:
await server.stop();              // all clients see the connection drop
```

### Configuration options

```ts
new MockSolaceServer({
  smfWsPort: 0,                 // SMF WebSocket port; 0 = ephemeral (Solace default: 8008)
  sempPort: 0,                  // SEMP port; 0 = ephemeral, false = disable SEMP (default: 8080)
  host: '127.0.0.1',            // bind address
  vpns: ['default'],            // VPNs existing at startup
  autoCreateVpns: true,         // create VPNs on first login
  validateCredentials: undefined, // (creds) => true | false | { code, text }
  keepAliveIntervalSec: 3,      // advertised keepalive interval
  clientLivenessTimeoutMs: 0,   // 0 disables idle-client eviction (breakpoint-friendly)
  maxBufferedBytes: 8388608,    // per-subscriber backpressure cap; beyond it, direct msgs drop
  captureMessages: true,        // record published messages for inspection
  maxCapturedMessages: 1000,    // capture ring-buffer size
  routerName: 'mock-solace',    // router name reported to clients
});
```

`start()` resolves with the actual addresses:

```ts
const { smfWsPort, smfWsUrl, sempPort, sempUrl } = await server.start();
```

## SEMP v2 endpoints

```
GET           /SEMP/v2/{config|monitor}/msgVpns
GET           /SEMP/v2/{config|monitor}/msgVpns/{vpn}
GET, POST     /SEMP/v2/config/msgVpns/{vpn}/queues
GET, DELETE   /SEMP/v2/config/msgVpns/{vpn}/queues/{queue}
GET, POST     /SEMP/v2/config/msgVpns/{vpn}/queues/{queue}/subscriptions
DELETE        /SEMP/v2/config/msgVpns/{vpn}/queues/{queue}/subscriptions/{topic}
GET           /SEMP/v2/monitor/msgVpns/{vpn}/queues/{queue}/msgs
```

Responses use the SEMP v2 `{ data, meta }` envelope, so provisioning code
written against a real broker works as-is:

```sh
# Create a queue
curl -X POST http://127.0.0.1:8080/SEMP/v2/config/msgVpns/default/queues \
  -H 'content-type: application/json' \
  -d '{"queueName": "q/orders", "accessType": "exclusive"}'

# Subscribe the queue to a topic
curl -X POST http://127.0.0.1:8080/SEMP/v2/config/msgVpns/default/queues/q%2Forders/subscriptions \
  -H 'content-type: application/json' \
  -d '{"subscriptionTopic": "orders/>"}'

# Inspect spooled messages
curl http://127.0.0.1:8080/SEMP/v2/monitor/msgVpns/default/queues/q%2Forders/msgs
```

(Queue names containing `/` must be URL-encoded in paths, e.g. `q%2Forders`.)

## How protocol fidelity is maintained

- Byte layouts were extracted from primary sources — the unminified
  `solclientjs` debug bundle and Solace's open-source Wireshark SMF dissector —
  and are documented with citations in [`docs/protocol-notes.md`](docs/protocol-notes.md).
- The integration test suite connects **real `solclientjs` sessions** to the
  mock; the SDK itself is the compatibility oracle.

## Development

```sh
npm install
npm test          # unit + property + integration suites
npm run build     # emits dist/ with type declarations
```
