import {
  ClientCtrlMsgType,
  ClientCtrlParam,
  ClientCtrlVersion,
  ROUTER_CAP_BIT_COUNT,
  SmfProtocol,
} from '../constants.js';
import { encodeSmfFrame, SmfDecodeError } from '../header.js';
import { encodeResponseParam } from '../params.js';

/** Decoded ClientCtrl body (login/update). See docs/protocol-notes.md §5. */
export interface ClientCtrlMessage {
  msgType: number;
  /** Raw params keyed by type id (string values keep their null terminator). */
  params: Map<number, Buffer>;
}

function stripNull(buf: Buffer): string {
  const s = buf.toString('utf8');
  return s.endsWith('\0') ? s.slice(0, -1) : s;
}

export function decodeClientCtrl(payload: Buffer): ClientCtrlMessage {
  if (payload.length < 6) throw new SmfDecodeError('ClientCtrl body too short');
  const twobytes = payload.readUInt16BE(0);
  const version = (twobytes >>> 8) & 0x07;
  const msgType = twobytes & 0xff;
  if (version !== ClientCtrlVersion) {
    throw new SmfDecodeError(`unsupported ClientCtrl version ${version}`);
  }
  const len = payload.readUInt32BE(2);
  if (len < 6 || len > payload.length) {
    throw new SmfDecodeError('invalid ClientCtrl length');
  }
  const params = new Map<number, Buffer>();
  let pos = 6;
  while (pos < len) {
    const b = payload.readUInt8(pos);
    pos++;
    const type = b & 0x7f;
    const paramLen = payload.readUInt32BE(pos);
    pos += 4;
    const valueLen = paramLen - 5;
    if (valueLen < 0 || pos + valueLen > len) {
      throw new SmfDecodeError('ClientCtrl param overruns body');
    }
    params.set(type, payload.subarray(pos, pos + valueLen));
    pos += valueLen;
  }
  return { msgType, params };
}

export function getStringParam(msg: ClientCtrlMessage, type: number): string | undefined {
  const v = msg.params.get(type);
  return v === undefined ? undefined : stripNull(v);
}

/** Fields the client supplies in its Login request, in friendly form. */
export interface LoginRequest {
  clientName?: string;
  vpnName?: string;
  platform?: string;
  softwareVersion?: string;
  clientDescription?: string;
  /** Keepalive interval in seconds (u32). */
  keepAliveIntervalSec?: number;
}

export function parseLoginRequest(msg: ClientCtrlMessage): LoginRequest {
  const ka = msg.params.get(ClientCtrlParam.KEEP_ALIVE_INTERVAL);
  return {
    clientName: getStringParam(msg, ClientCtrlParam.CLIENTNAME),
    vpnName: getStringParam(msg, ClientCtrlParam.MSGVPNNAME),
    platform: getStringParam(msg, ClientCtrlParam.PLATFORM),
    softwareVersion: getStringParam(msg, ClientCtrlParam.SOFTWAREVERSION),
    clientDescription: getStringParam(msg, ClientCtrlParam.CLIENTDESC),
    keepAliveIntervalSec: ka && ka.length >= 4 ? ka.readUInt32BE(0) : undefined,
  };
}

function encodeClientCtrlParam(type: number, value: Buffer): Buffer {
  const out = Buffer.alloc(5 + value.length);
  out.writeUInt8(type & 0x7f, 0);
  out.writeUInt32BE(value.length + 5, 1);
  value.copy(out, 5);
  return out;
}

function nullTerminated(s: string): Buffer {
  return Buffer.from(`${s}\0`, 'utf8');
}

export interface RouterCapabilities {
  booleanBits: number[];
  maxDirectMsgSize?: number;
  maxGuaranteedMsgSize?: number;
}

function encodeRouterCapabilities(caps: RouterCapabilities): Buffer {
  const bitmap = Buffer.alloc(Math.ceil(ROUTER_CAP_BIT_COUNT / 8));
  for (const bit of caps.booleanBits) {
    const byteIdx = bit >> 3;
    bitmap[byteIdx] = bitmap[byteIdx]! | (0x80 >> (bit & 7));
  }
  const parts: Buffer[] = [Buffer.from([ROUTER_CAP_BIT_COUNT]), bitmap];
  const extU32 = (type: number, v: number) => {
    const value = Buffer.alloc(4);
    value.writeUInt32BE(v, 0);
    const e = Buffer.alloc(5 + 4);
    e.writeUInt8(type, 0);
    e.writeUInt32BE(9, 1);
    value.copy(e, 5);
    parts.push(e);
  };
  if (caps.maxGuaranteedMsgSize !== undefined) extU32(2, caps.maxGuaranteedMsgSize);
  if (caps.maxDirectMsgSize !== undefined) extU32(3, caps.maxDirectMsgSize);
  return Buffer.concat(parts);
}

export interface LoginResponseOptions {
  responseCode: number;
  responseText: string;
  clientName: string;
  vpnName: string;
  /** e.g. `#P2P/v:mock-router/abc123/myclient` — SDK appends `/_` and `/>`. */
  p2pTopicBase: string;
  virtualRouterName: string;
  physicalRouterName: string;
  capabilities: RouterCapabilities;
  /** Keepalive interval to advertise, in seconds. */
  keepAliveIntervalSec: number;
}

/** Builds the complete SMF frame for a ClientCtrl LOGIN response. */
export function encodeLoginResponse(opts: LoginResponseOptions): Buffer {
  const ccParams: Buffer[] = [];
  if (opts.responseCode === 200) {
    ccParams.push(
      encodeClientCtrlParam(ClientCtrlParam.CLIENTNAME, nullTerminated(opts.clientName)),
      encodeClientCtrlParam(ClientCtrlParam.MSGVPNNAME, nullTerminated(opts.vpnName)),
      encodeClientCtrlParam(ClientCtrlParam.P2PTOPIC, nullTerminated(opts.p2pTopicBase)),
      encodeClientCtrlParam(ClientCtrlParam.VRIDNAME, nullTerminated(opts.virtualRouterName)),
      encodeClientCtrlParam(
        ClientCtrlParam.PHYSICALROUTERNAME,
        nullTerminated(opts.physicalRouterName),
      ),
      encodeClientCtrlParam(
        ClientCtrlParam.ROUTER_CAPABILITIES,
        encodeRouterCapabilities(opts.capabilities),
      ),
    );
    const ka = Buffer.alloc(4);
    ka.writeUInt32BE(opts.keepAliveIntervalSec, 0);
    ccParams.push(encodeClientCtrlParam(ClientCtrlParam.KEEP_ALIVE_INTERVAL, ka));
  }
  const paramData = Buffer.concat(ccParams);
  const body = Buffer.alloc(6 + paramData.length);
  body.writeUInt16BE((ClientCtrlVersion << 8) | ClientCtrlMsgType.LOGIN, 0);
  body.writeUInt32BE(6 + paramData.length, 2);
  paramData.copy(body, 6);

  const smfParams = encodeResponseParam(opts.responseCode, opts.responseText);
  return encodeSmfFrame({ protocol: SmfProtocol.CLIENTCTRL, ttl: 1 }, smfParams, body);
}
