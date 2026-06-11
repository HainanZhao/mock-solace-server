import { randomUUID } from 'node:crypto';
import { ClientInfo } from '../api/events.js';
import { ResolvedOptions } from '../config.js';
import { decodeSmf, SmfMessage } from '../smf/codec.js';
import {
  ClientCtrlMsgType,
  ClientCtrlVersion,
  SmfProtocol,
  SmpMsgType,
} from '../smf/constants.js';
import { encodeSmfFrame } from '../smf/header.js';
import { encodeCorrelationTagParam, encodeResponseParam } from '../smf/params.js';
import {
  decodeClientCtrl,
  encodeLoginResponse,
  parseLoginRequest,
} from '../smf/messages/client-ctrl.js';
import { encodeKeepAlive } from '../smf/messages/keepalive.js';
import { decodeSmp, encodeSmpResponse, responseRequired } from '../smf/messages/smp.js';
import { DirectMessage } from '../smf/messages/trmsg.js';
import { Connection } from '../transport/connection.js';
import { SmfFramer } from '../transport/framer.js';
import { InvalidSubscriptionError } from './topic-matcher.js';
import { Subscriber } from './vpn.js';

export type SessionState = 'awaiting-login' | 'up' | 'closed';

export interface SessionHost {
  options: ResolvedOptions;
  /** Returns the VPN name to use, or null to reject the login. */
  authenticateLogin(msg: SmfMessage, vpnName: string, clientName: string):
    | { ok: true }
    | { ok: false; code: number; text: string };
  vpnExists(name: string): boolean;
  addSubscription(session: ClientSession, subscription: string): void;
  removeSubscription(session: ClientSession, subscription: string): void;
  addQueueSubscription(vpnName: string, queueName: string, subscription: string): void;
  removeQueueSubscription(vpnName: string, queueName: string, subscription: string): boolean;
  routeDirectMessage(session: ClientSession, msg: SmfMessage): void;
  onSessionUp(session: ClientSession): void;
  onSessionClosed(session: ClientSession): void;
}

let clientNameCounter = 0;

export class ClientSession implements Subscriber {
  state: SessionState = 'awaiting-login';
  clientName = '';
  vpnName = '';
  username: string | undefined;
  readonly subscriptions = new Set<string>();
  readonly subscriberId = randomUUID();
  private readonly framer: SmfFramer;
  private livenessTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly conn: Connection,
    private readonly host: SessionHost,
  ) {
    this.framer = new SmfFramer(
      (frame) => this.onFrame(frame),
      () => this.conn.close(),
    );
    conn.onBytes((chunk) => {
      this.touchLiveness();
      this.framer.push(chunk);
    });
    conn.onClose(() => this.handleClosed());
    this.touchLiveness();
  }

  get remoteAddress(): string {
    return this.conn.remoteAddress;
  }

  info(): ClientInfo {
    return {
      clientName: this.clientName,
      vpnName: this.vpnName,
      username: this.username,
      remoteAddress: this.remoteAddress,
      subscriptions: [...this.subscriptions],
    };
  }

  private touchLiveness(): void {
    const timeout = this.host.options.clientLivenessTimeoutMs;
    if (timeout <= 0) return;
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => this.conn.close(), timeout);
    this.livenessTimer.unref?.();
  }

  private onFrame(frame: Buffer): void {
    let msg: SmfMessage;
    try {
      msg = decodeSmf(frame);
    } catch {
      this.conn.close();
      return;
    }
    if (this.state === 'awaiting-login') {
      if (msg.header.protocol !== SmfProtocol.CLIENTCTRL) {
        this.conn.close();
        return;
      }
      this.handleLogin(msg);
      return;
    }
    if (this.state !== 'up') return;
    switch (msg.header.protocol) {
      case SmfProtocol.KEEPALIVE:
      case SmfProtocol.KEEPALIVEV2:
        this.conn.send(encodeKeepAlive());
        break;
      case SmfProtocol.SMP:
        this.handleSmp(msg);
        break;
      case SmfProtocol.TRMSG:
        this.host.routeDirectMessage(this, msg);
        break;
      case SmfProtocol.CLIENTCTRL:
        this.handleClientCtrlUpdate(msg);
        break;
      default:
        // Unknown/unsupported protocol (e.g. ADCTRL before M6): ignore.
        break;
    }
  }

  private handleLogin(msg: SmfMessage): void {
    let login;
    try {
      const cc = decodeClientCtrl(msg.payload);
      if (cc.msgType !== ClientCtrlMsgType.LOGIN) {
        this.conn.close();
        return;
      }
      login = parseLoginRequest(cc);
    } catch {
      this.conn.close();
      return;
    }
    const vpnName = login.vpnName || 'default';
    const clientName = login.clientName || `mock-client-${++clientNameCounter}`;
    this.username = msg.params.username;

    const auth = this.host.authenticateLogin(msg, vpnName, clientName);
    if (!auth.ok) {
      this.conn.send(this.loginResponse(auth.code, auth.text, vpnName, clientName));
      this.conn.close();
      return;
    }
    this.vpnName = vpnName;
    this.clientName = clientName;
    this.state = 'up';
    this.conn.send(this.loginResponse(200, 'OK', vpnName, clientName));
    this.host.onSessionUp(this);
  }

  private loginResponse(code: number, text: string, vpnName: string, clientName: string): Buffer {
    const opts = this.host.options;
    return encodeLoginResponse({
      responseCode: code,
      responseText: text,
      clientName,
      vpnName,
      p2pTopicBase: `#P2P/v:${opts.routerName}/${this.subscriberId.slice(0, 8)}/${clientName}`,
      virtualRouterName: `v:${opts.routerName}`,
      physicalRouterName: opts.routerName,
      capabilities: {
        // NO_LOCAL only; all guaranteed-messaging bits stay off until M6.
        booleanBits: [14],
        maxDirectMsgSize: 64 * 1024 * 1024,
      },
      keepAliveIntervalSec: opts.keepAliveIntervalSec,
    });
  }

  private handleClientCtrlUpdate(msg: SmfMessage): void {
    // ClientCtrl UPDATE (rename client etc.): acknowledge with 200. Unlike
    // LOGIN, the SDK matches UPDATE responses by correlation tag.
    try {
      const cc = decodeClientCtrl(msg.payload);
      if (cc.msgType !== ClientCtrlMsgType.UPDATE) return;
    } catch {
      return;
    }
    // Minimal ack: echo as a login-style ClientCtrl with the corrtag.
    // Built inline to include the correlation tag param.
    this.conn.send(buildUpdateAck(msg));
  }

  private handleSmp(msg: SmfMessage): void {
    let smp;
    try {
      smp = decodeSmp(msg.payload);
    } catch {
      return;
    }
    let code = 200;
    let text = 'OK';
    try {
      switch (smp.msgType) {
        case SmpMsgType.ADDSUBSCRIPTION:
          this.host.addSubscription(this, smp.subscription);
          break;
        case SmpMsgType.REMSUBSCRIPTION:
          this.host.removeSubscription(this, smp.subscription);
          break;
        case SmpMsgType.ADDQUEUESUBSCRIPTION:
          this.host.addQueueSubscription(this.vpnName, smp.queueName!, smp.subscription);
          break;
        case SmpMsgType.REMQUEUESUBSCRIPTION:
          this.host.removeQueueSubscription(this.vpnName, smp.queueName!, smp.subscription);
          break;
        default:
          code = 400;
          text = 'Unsupported subscription operation';
          break;
      }
    } catch (err) {
      if (err instanceof InvalidSubscriptionError) {
        code = 400;
        text = 'Invalid Topic Syntax';
      } else {
        code = 503;
        text = 'Subscription error';
      }
    }
    if (responseRequired(smp)) {
      this.conn.send(encodeSmpResponse(smp, msg.params.correlationTag, code, text));
    }
  }

  /** Subscriber implementation: forward the routed frame, with backpressure cap. */
  deliver(message: DirectMessage): boolean {
    if (this.state !== 'up') return false;
    if (this.conn.bufferedAmount() > this.host.options.maxBufferedBytes) return false;
    this.conn.send(message.raw);
    return true;
  }

  sendKeepAlive(): void {
    if (this.state === 'up') this.conn.send(encodeKeepAlive());
  }

  close(): void {
    this.conn.close();
  }

  private handleClosed(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    const wasUp = this.state === 'up';
    this.state = 'closed';
    if (wasUp) this.host.onSessionClosed(this);
  }
}

function buildUpdateAck(request: SmfMessage): Buffer {
  const body = Buffer.alloc(6);
  body.writeUInt16BE((ClientCtrlVersion << 8) | ClientCtrlMsgType.UPDATE, 0);
  body.writeUInt32BE(6, 2);
  const params: Buffer[] = [];
  if (request.params.correlationTag !== undefined) {
    params.push(encodeCorrelationTagParam(request.params.correlationTag));
  }
  params.push(encodeResponseParam(200, 'OK'));
  return encodeSmfFrame(
    { protocol: SmfProtocol.CLIENTCTRL, ttl: 1 },
    Buffer.concat(params),
    body,
  );
}
