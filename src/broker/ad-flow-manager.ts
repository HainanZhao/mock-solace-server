import { SmfMessage } from '../smf/codec.js';
import { AdMsgType, AdParam, SmfParam, SmfProtocol, WireDeliveryMode } from '../smf/constants.js';
import { decodeSmf } from '../smf/codec.js';
import { encodeSmfFrame } from '../smf/header.js';
import { encodeSmfParam } from '../smf/params.js';
import {
  decodeAdProtocol,
  encodeAdSimpleResponse,
  encodeBindResponse,
  getAdString,
  getAdU32,
  getAdU8,
} from '../smf/messages/assured-ctrl.js';
import { ClientSession } from './client-session.js';
import { Queue, StoredMessage } from './queue.js';

interface ConsumerFlow {
  flowId: number;
  session: ClientSession;
  queue: Queue;
  windowSize: number;
  /** Last message id delivered on this flow (prev-id chain for the SDK). */
  lastDelivered: number;
}

let nextFlowId = 1;

/**
 * Guaranteed-messaging consumer flows: BIND/UNBIND handling, in-order
 * delivery of spooled queue messages, and client acks. Happy path only —
 * no publisher flows, transactions, selectors, or replay.
 */
export class AdFlowManager {
  private readonly flows = new Map<number, ConsumerFlow>();

  constructor(private readonly getQueue: (vpn: string, name: string) => Queue | undefined) {}

  handleAdCtrl(session: ClientSession, msg: SmfMessage): void {
    let ad;
    try {
      ad = decodeAdProtocol(msg.payload);
    } catch {
      return;
    }
    const corrtag = msg.params.correlationTag;
    switch (ad.msgType) {
      case AdMsgType.BIND: {
        const queueName = getAdString(ad, AdParam.QUEUENAME);
        const queue = queueName ? this.getQueue(session.vpnName, queueName) : undefined;
        if (!queue) {
          session.sendFrame(
            encodeBindResponse({
              correlationTag: corrtag,
              responseCode: 503,
              responseText: 'Unknown Queue',
              flowId: 0,
              windowSize: 0,
              lastMsgIdAcked: 0,
            }),
          );
          return;
        }
        const flow: ConsumerFlow = {
          flowId: nextFlowId++,
          session,
          queue,
          windowSize: getAdU8(ad, AdParam.WINDOW) ?? getAdU32(ad, AdParam.TRANSPORT_WINDOW) ?? 255,
          lastDelivered: 0,
        };
        this.flows.set(flow.flowId, flow);
        session.sendFrame(
          encodeBindResponse({
            correlationTag: corrtag,
            responseCode: 200,
            responseText: 'OK',
            flowId: flow.flowId,
            windowSize: flow.windowSize,
            lastMsgIdAcked: 0,
          }),
        );
        queue.onSpooled = () => this.drain(flow);
        // Drain after the bind response so deliveries follow flow-up.
        queueMicrotask(() => this.drain(flow));
        return;
      }
      case AdMsgType.CLIENTACK: {
        const flowId = getAdU32(ad, AdParam.FLOWID);
        const flow = flowId !== undefined ? this.flows.get(flowId) : undefined;
        if (!flow) return;
        for (const range of ad.applicationAcks) {
          for (const stored of [...flow.queue.messages]) {
            if (stored.msgId >= range.min && stored.msgId <= range.max) {
              flow.queue.ack(stored.msgId);
            }
          }
        }
        return;
      }
      case AdMsgType.UNBIND: {
        const flowId = getAdU32(ad, AdParam.FLOWID);
        if (flowId !== undefined) this.teardownFlow(flowId);
        session.sendFrame(
          encodeAdSimpleResponse(AdMsgType.UNBIND, corrtag, 200, 'OK', flowId),
        );
        return;
      }
      default:
        // Unsupported AD operation (pub flows, transactions, ...): reject if
        // the client awaits a correlated response, otherwise ignore.
        if (corrtag !== undefined) {
          session.sendFrame(
            encodeAdSimpleResponse(ad.msgType, corrtag, 501, 'Not Supported'),
          );
        }
        return;
    }
  }

  sessionClosed(session: ClientSession): void {
    for (const [flowId, flow] of this.flows) {
      if (flow.session === session) this.teardownFlow(flowId);
    }
  }

  private teardownFlow(flowId: number): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    this.flows.delete(flowId);
    if (flow.queue.onSpooled) flow.queue.onSpooled = undefined;
    flow.queue.releaseInflight();
  }

  private drain(flow: ConsumerFlow): void {
    if (!this.flows.has(flow.flowId)) return;
    for (const stored of [...flow.queue.messages]) {
      if (flow.queue.inflight.has(stored.msgId)) continue;
      flow.queue.inflight.add(stored.msgId);
      const frame = this.buildGuaranteedFrame(flow, stored);
      flow.session.sendFrame(frame);
      flow.lastDelivered = stored.msgId;
    }
  }

  /**
   * Re-frames a spooled publisher message as a guaranteed delivery: ADF flag
   * set, original params preserved, AD params (msg id chain, flow id,
   * persistent delivery mode, redelivered flag) appended.
   */
  private buildGuaranteedFrame(flow: ConsumerFlow, stored: StoredMessage): Buffer {
    const original = decodeSmf(stored.raw);
    const msgId = Buffer.alloc(8);
    msgId.writeBigUInt64BE(BigInt(stored.msgId), 0);
    const prevMsgId = Buffer.alloc(8);
    prevMsgId.writeBigUInt64BE(BigInt(flow.lastDelivered), 0);
    const flowId = Buffer.alloc(4);
    flowId.writeUInt32BE(flow.flowId, 0);
    const adParams: Buffer[] = [
      encodeSmfParam(2, SmfParam.ASSURED_MESSAGE_ID, msgId),
      encodeSmfParam(2, SmfParam.ASSURED_PREVMESSAGE_ID, prevMsgId),
      encodeSmfParam(0, SmfParam.ASSURED_FLOWID, flowId),
      encodeSmfParam(0, SmfParam.DELIVERY_MODE, Buffer.from([WireDeliveryMode.PERSISTENT])),
    ];
    if (stored.redelivered) {
      adParams.push(encodeSmfParam(0, SmfParam.ASSURED_REDELIVERED_FLAG, Buffer.alloc(0)));
    }
    return encodeSmfFrame(
      { protocol: SmfProtocol.TRMSG, ttl: original.header.ttl, adf: true },
      Buffer.concat([original.params.raw, ...adParams]),
      original.payload,
    );
  }
}
