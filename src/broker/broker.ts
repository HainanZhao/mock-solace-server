import { CapturedMessage, ServerEventEmitter } from '../api/events.js';
import { ResolvedOptions } from '../config.js';
import { SmfMessage } from '../smf/codec.js';
import { trMsgFromSmf } from '../smf/messages/trmsg.js';
import { Connection } from '../transport/connection.js';
import { ClientSession, SessionHost } from './client-session.js';
import { Queue, QueueProperties } from './queue.js';
import { MessageVpn } from './vpn.js';

export class Broker implements SessionHost {
  readonly vpns = new Map<string, MessageVpn>();
  readonly sessions = new Set<ClientSession>();
  private captured: CapturedMessage[] = [];

  constructor(
    readonly options: ResolvedOptions,
    readonly events: ServerEventEmitter,
  ) {
    for (const name of options.vpns) this.vpns.set(name, new MessageVpn(name));
  }

  acceptConnection(conn: Connection): void {
    new ClientSession(conn, this);
  }

  getVpn(name: string): MessageVpn | undefined {
    return this.vpns.get(name);
  }

  getOrCreateVpn(name: string): MessageVpn {
    let vpn = this.vpns.get(name);
    if (!vpn) {
      vpn = new MessageVpn(name);
      this.vpns.set(name, vpn);
    }
    return vpn;
  }

  vpnExists(name: string): boolean {
    return this.vpns.has(name);
  }

  authenticateLogin(
    msg: SmfMessage,
    vpnName: string,
    clientName: string,
  ): { ok: true } | { ok: false; code: number; text: string } {
    if (!this.vpns.has(vpnName)) {
      if (!this.options.autoCreateVpns) {
        return { ok: false, code: 403, text: 'Message VPN Not Allowed' };
      }
      this.getOrCreateVpn(vpnName);
    }
    const validate = this.options.validateCredentials;
    if (validate) {
      const result = validate({
        username: msg.params.username,
        password: msg.params.password,
        vpnName,
        clientName,
      });
      if (result !== true) {
        return result === false
          ? { ok: false, code: 401, text: 'Unauthorized' }
          : { ok: false, code: result.code, text: result.text };
      }
    }
    return { ok: true };
  }

  onSessionUp(session: ClientSession): void {
    this.sessions.add(session);
    this.events.emit('clientConnected', session.info());
  }

  onSessionClosed(session: ClientSession): void {
    this.sessions.delete(session);
    const vpn = this.vpns.get(session.vpnName);
    vpn?.trie.removeAll(session);
    this.events.emit('clientDisconnected', session.info());
  }

  addSubscription(session: ClientSession, subscription: string): void {
    const vpn = this.getOrCreateVpn(session.vpnName);
    vpn.trie.add(subscription, session);
    session.subscriptions.add(subscription);
    this.events.emit('subscriptionAdded', session.info(), subscription);
  }

  removeSubscription(session: ClientSession, subscription: string): void {
    const vpn = this.vpns.get(session.vpnName);
    vpn?.trie.remove(subscription, session);
    session.subscriptions.delete(subscription);
    this.events.emit('subscriptionRemoved', session.info(), subscription);
  }

  createQueue(vpnName: string, queueName: string, props: Partial<QueueProperties> = {}): Queue {
    const vpn = this.getOrCreateVpn(vpnName);
    const existing = vpn.queues.get(queueName);
    if (existing) throw new Error(`queue '${queueName}' already exists`);
    const queue = new Queue(queueName, vpnName, props);
    vpn.queues.set(queueName, queue);
    return queue;
  }

  deleteQueue(vpnName: string, queueName: string): boolean {
    const vpn = this.vpns.get(vpnName);
    const queue = vpn?.queues.get(queueName);
    if (!vpn || !queue) return false;
    vpn.trie.removeAll(queue);
    vpn.queues.delete(queueName);
    return true;
  }

  addQueueSubscription(vpnName: string, queueName: string, subscription: string): void {
    const vpn = this.vpns.get(vpnName);
    const queue = vpn?.queues.get(queueName);
    if (!vpn || !queue) throw new Error(`queue '${queueName}' not found`);
    vpn.trie.add(subscription, queue);
    queue.topicSubscriptions.add(subscription);
  }

  removeQueueSubscription(vpnName: string, queueName: string, subscription: string): boolean {
    const vpn = this.vpns.get(vpnName);
    const queue = vpn?.queues.get(queueName);
    if (!vpn || !queue) return false;
    queue.topicSubscriptions.delete(subscription);
    return vpn.trie.remove(subscription, queue);
  }

  getQueue(vpnName: string, queueName: string): Queue | undefined {
    return this.vpns.get(vpnName)?.queues.get(queueName);
  }

  routeDirectMessage(session: ClientSession, msg: SmfMessage): void {
    const dm = trMsgFromSmf(msg);
    if (!dm) return;
    const vpn = this.vpns.get(session.vpnName);
    if (!vpn) return;
    let delivered = 0;
    const matches = vpn.trie.match(dm.topic);
    for (const subscriber of matches) {
      const captured: CapturedMessage = {
        topic: dm.topic,
        payload: dm.payload,
        vpnName: session.vpnName,
        publisherClientName: session.clientName,
        deliveredTo: 0,
        timestamp: Date.now(),
      };
      if (subscriber.deliver(dm)) delivered++;
      else this.events.emit('messageDiscarded', captured, 'backpressure');
    }
    const record: CapturedMessage = {
      topic: dm.topic,
      payload: dm.payload,
      vpnName: session.vpnName,
      publisherClientName: session.clientName,
      deliveredTo: delivered,
      timestamp: Date.now(),
    };
    if (this.options.captureMessages) {
      this.captured.push(record);
      if (this.captured.length > this.options.maxCapturedMessages) {
        this.captured.splice(0, this.captured.length - this.options.maxCapturedMessages);
      }
    }
    this.events.emit('messagePublished', record);
  }

  capturedMessages(): CapturedMessage[] {
    return [...this.captured];
  }

  clearCapturedMessages(): void {
    this.captured = [];
  }

  closeAllSessions(): void {
    for (const session of [...this.sessions]) session.close();
  }
}
