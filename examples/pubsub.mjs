/**
 * End-to-end demo: starts the mock broker on Solace's conventional ports,
 * connects two real solclientjs sessions, exercises wildcard pub/sub and a
 * queue, then shuts down. Run `npm run build` first, then:
 *
 *   node examples/pubsub.mjs
 */
import { createRequire } from 'node:module';
import { MockSolaceServer } from '../dist/index.js';

const require = createRequire(import.meta.url);
const solace = require('solclientjs');

solace.SolclientFactory.init(
  new solace.SolclientFactoryProperties({
    profile: solace.SolclientFactoryProfiles.version10_5,
  }),
);
solace.SolclientFactory.setLogLevel(solace.LogLevel.WARN);

// Solace's conventional ports are 8008 (SMF/WS) and 8080 (SEMP); use offset
// ports here so the demo doesn't collide with anything local.
const server = new MockSolaceServer({ smfWsPort: 18008, sempPort: 18080 });
const { smfWsUrl, sempUrl } = await server.start();
console.log(`mock broker up: smf=${smfWsUrl} semp=${sempUrl}`);

server.createQueue('q/demo', { topics: ['demo/>'] });

function session(clientName) {
  return solace.SolclientFactory.createSession(
    new solace.SessionProperties({
      url: smfWsUrl,
      vpnName: 'default',
      userName: 'demo',
      password: 'demo',
      clientName,
    }),
  );
}

function connect(s) {
  return new Promise((resolve, reject) => {
    s.on(solace.SessionEventCode.UP_NOTICE, resolve);
    s.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e) => reject(new Error(e.infoStr)));
    s.connect();
  });
}

const sub = session('demo-subscriber');
const pub = session('demo-publisher');
await Promise.all([connect(sub), connect(pub)]);
console.log('both sessions UP');

sub.on(solace.SessionEventCode.MESSAGE, (m) => {
  console.log(
    `subscriber got [${m.getDestination().getName()}]: ${m.getBinaryAttachment()}`,
  );
});
await new Promise((resolve) => {
  sub.on(solace.SessionEventCode.SUBSCRIPTION_OK, resolve);
  sub.subscribe(solace.SolclientFactory.createTopicDestination('demo/*/events'), true, 'k', 5000);
});

const msg = solace.SolclientFactory.createMessage();
msg.setDestination(solace.SolclientFactory.createTopicDestination('demo/eu/events'));
msg.setBinaryAttachment('hello from the mock');
msg.setDeliveryMode(solace.MessageDeliveryModeType.DIRECT);
pub.send(msg);

await new Promise((r) => setTimeout(r, 300));

const queue = server.getQueue('q/demo');
console.log(`queue q/demo spooled ${queue.messages.length} message(s)`);
const sempQueues = await fetch(`${sempUrl}/SEMP/v2/config/msgVpns/default/queues`).then((r) =>
  r.json(),
);
console.log('SEMP queues:', sempQueues.data.map((q) => q.queueName).join(', '));

sub.dispose();
pub.dispose();
await server.stop();
console.log('done');
