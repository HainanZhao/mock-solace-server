import { TypedEventEmitter } from '../util/emitter.js';

export interface ClientInfo {
  clientName: string;
  vpnName: string;
  username?: string;
  remoteAddress: string;
  subscriptions: string[];
}

export interface CapturedMessage {
  topic: string;
  payload: Uint8Array;
  vpnName: string;
  publisherClientName: string;
  deliveredTo: number;
  timestamp: number;
}

export interface ServerEvents {
  clientConnected: [client: ClientInfo];
  clientDisconnected: [client: ClientInfo];
  subscriptionAdded: [client: ClientInfo, subscription: string];
  subscriptionRemoved: [client: ClientInfo, subscription: string];
  messagePublished: [message: CapturedMessage];
  messageDiscarded: [message: CapturedMessage, reason: string];
}

export class ServerEventEmitter extends TypedEventEmitter<ServerEvents> {}
