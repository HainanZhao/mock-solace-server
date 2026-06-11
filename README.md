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

## Test-friendly API

```ts
const server = new MockSolaceServer({
  vpns: ['default', 'other'],
  validateCredentials: ({ username, password }) => username === 'svc' && password === 's3cret',
});

server.clients();                  // connected clients + their subscriptions
server.capturedMessages();         // every published message (topic, payload, publisher, fan-out count)
await server.waitForMessage((m) => m.topic === 'orders/created');

server.createQueue('q/orders', { topics: ['orders/>'] });
server.getQueue('q/orders')!.messages;   // spooled messages

server.on('clientConnected', (c) => ...);
server.on('messagePublished', (m) => ...);
server.on('subscriptionAdded', (c, sub) => ...);
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

Responses use the SEMP v2 `{ data, meta }` envelope.

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
