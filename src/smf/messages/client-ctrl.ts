import {
  ClientCtrlMsgType,
  ClientCtrlParam,
  ClientCtrlVersion,
  ROUTER_CAP_BIT_COUNT,
  SmfProtocol,
} from '../constants.js';
import { encodeSmfFrame, SmfDecodeError } from '../header.js';
import { encodeResponseParam } from '../params.js';
import {
  alloc,
  concat,
  fromUtf8,
  readU16BE,
  readU32BE,
  toUtf8,
  writeU16BE,
  writeU32BE,
} from '../../util/bytes.js';

/** Decoded ClientCtrl body (login/update). See docs/protocol-notes.md §5. */
export interface ClientCtrlMessage {
  msgType: number;
  /** Raw params keyed by type id (string values keep their null terminator). */
  params: Map<number, Uint8Array>;
}

function stripNull(buf: Uint8Array): string {
  const s = toUtf8(buf);
  return s.endsWith('\0') ? s.slice(0, -1) : s;
}

export function decodeClientCtrl(payload: Uint8Array): ClientCtrlMessage {
  if (payload.length < 6) throw new SmfDecodeError('ClientCtrl body too short');
  const twobytes = readU16BE(payload, 0);
  const version = (twobytes >>> 8) & 0x07;
  const msgType = twobytes & 0xff;
  if (version !== ClientCtrlVersion) {
    throw new SmfDecodeError(`unsupported ClientCtrl version ${version}`);
  }
  const len = readU32BE(payload, 2);
  if (len < 6 || len > payload.length) {
    throw new SmfDecodeError('invalid ClientCtrl length');
  }
  const params = new Map<number, Uint8Array>();
  let pos = 6;
  while (pos < len) {
    const b = payload[pos]!;
    pos++;
    const type = b & 0x7f;
    const paramLen = readU32BE(payload, pos);
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
    keepAliveIntervalSec: ka && ka.length >= 4 ? readU32BE(ka, 0) : undefined,
  };
}

function encodeClientCtrlParam(type: number, value: Uint8Array): Uint8Array {
  const out = alloc(5 + value.length);
  out[0] = type & 0x7f;
  writeU32BE(out, value.length + 5, 1);
  out.set(value, 5);
  return out;
}

function nullTerminated(s: string): Uint8Array {
  return fromUtf8(`${s}\0`);
}

export interface RouterCapabilities {
  booleanBits: number[];
  maxDirectMsgSize?: number;
  maxGuaranteedMsgSize?: number;
}

function encodeRouterCapabilities(caps: RouterCapabilities): Uint8Array {
  const bitmap = alloc(Math.ceil(ROUTER_CAP_BIT_COUNT / 8));
  for (const bit of caps.booleanBits) {
    const byteIdx = bit >> 3;
    bitmap[byteIdx] = bitmap[byteIdx]! | (0x80 >> (bit & 7));
  }
  const parts: Uint8Array[] = [Uint8Array.of(ROUTER_CAP_BIT_COUNT), bitmap];
  const extU32 = (type: number, v: number) => {
    const value = alloc(4);
    writeU32BE(value, v, 0);
    const e = alloc(5 + 4);
    e[0] = type;
    writeU32BE(e, 9, 1);
    e.set(value, 5);
    parts.push(e);
  };
  if (caps.maxGuaranteedMsgSize !== undefined) extU32(2, caps.maxGuaranteedMsgSize);
  if (caps.maxDirectMsgSize !== undefined) extU32(3, caps.maxDirectMsgSize);
  return concat(parts);
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
export function encodeLoginResponse(opts: LoginResponseOptions): Uint8Array {
  const ccParams: Uint8Array[] = [];
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
    const ka = alloc(4);
    writeU32BE(ka, opts.keepAliveIntervalSec, 0);
    ccParams.push(encodeClientCtrlParam(ClientCtrlParam.KEEP_ALIVE_INTERVAL, ka));
  }
  const paramData = concat(ccParams);
  const body = alloc(6 + paramData.length);
  writeU16BE(body, (ClientCtrlVersion << 8) | ClientCtrlMsgType.LOGIN, 0);
  writeU32BE(body, 6 + paramData.length, 2);
  body.set(paramData, 6);

  const smfParams = encodeResponseParam(opts.responseCode, opts.responseText);
  return encodeSmfFrame({ protocol: SmfProtocol.CLIENTCTRL, ttl: 1 }, smfParams, body);
}
