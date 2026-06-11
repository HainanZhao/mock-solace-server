# solace-server

A **mock Solace PubSub+ broker** for testing environments. It speaks the real
SMF binary wire protocol over WebSocket, so the official
[`solclientjs`](https://www.npmjs.com/package/solclientjs) SDK connects to it
**unmodified** — no test doubles, no SDK shims.

Built for test suites: in-memory, fast startup, ephemeral ports, inspection
hooks, and a minimal SEMP v2 management API for provisioning.

**Priorities:** direct messaging / topic routing is first-class. Queues are
supported for spooling and SEMP provisioning; guaranteed-messaging consumer
flows are minimal (happy path).

## Requirements

- Node.js >= 22

## Quick start

```ts
import { MockSolaceServer } from 'solace-server';
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

## What's implemented

| Area | Status |
|---|---|
| SMF over WebSocket (subprotocol `smf.solacesystems.com`) | ✅ |
| ClientCtrl login handshake, keepalives, clean disconnect | ✅ |
| SMP subscribe/unsubscribe with confirmations | ✅ |
| Direct message routing (TrMsg), SDT payloads pass through intact | ✅ |
| Solace wildcards: `*`, `abc*` prefix, trailing `>` | ✅ (property-tested) |
| Multiple message VPNs (auto-created on login by default) | ✅ |
| Queues + queue topic subscriptions (spooling) | ✅ |
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

### Using it in vitest / jest

```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MockSolaceServer } from 'solace-server';

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
