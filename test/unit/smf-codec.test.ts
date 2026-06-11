import { describe, expect, it } from 'vitest';
import { decodeSmf } from '../../src/smf/codec.js';
import { SmfProtocol, SmpFlags, SmpMsgType } from '../../src/smf/constants.js';
import { encodeSmfFrame } from '../../src/smf/header.js';
import {
  encodeCorrelationTagParam,
  encodeResponseParam,
  encodeSmfParam,
  encodeTopicNameParam,
} from '../../src/smf/params.js';
import { encodeKeepAlive } from '../../src/smf/messages/keepalive.js';
import { decodeSmp, encodeSmpRequest, encodeSmpResponse } from '../../src/smf/messages/smp.js';
import {
  decodeClientCtrl,
  encodeLoginResponse,
  parseLoginRequest,
} from '../../src/smf/messages/client-ctrl.js';
import { encodeDirectMessage, trMsgFromSmf } from '../../src/smf/messages/trmsg.js';

describe('SMF header', () => {
  it('keepalive frame matches the exact bytes solclientjs sends', () => {
    // Verified against solclientjs-debug.js:18409-18415 (UH=2, TTL=2, proto 11).
    expect(encodeKeepAlive()).toEqual(
      Buffer.from('038b0002000000 0c0000000c'.replace(/ /g, ''), 'hex'),
    );
  });

  it('round-trips header flags and fields', () => {
    const frame = encodeSmfFrame(
      { protocol: SmfProtocol.TRMSG, ttl: 255, dto: true, priority: 5 },
      Buffer.alloc(0),
      Buffer.from('xyz'),
    );
    const msg = decodeSmf(frame);
    expect(msg.header.protocol).toBe(SmfProtocol.TRMSG);
    expect(msg.header.ttl).toBe(255);
    expect(msg.header.dto).toBe(true);
    expect(msg.header.priority).toBe(5);
    expect(msg.header.headerLen).toBe(12);
    expect(msg.header.msgLen).toBe(15);
    expect(msg.payload.toString()).toBe('xyz');
  });

  it('rejects invalid version', () => {
    const frame = encodeKeepAlive();
    frame[0] = (frame[0]! & 0xf8) | 0x02;
    expect(() => decodeSmf(frame)).toThrow(/version/);
  });
});

describe('SMF params', () => {
  it('decodes response, correlation tag and topic name', () => {
    const params = Buffer.concat([
      encodeCorrelationTagParam(0xabcdef),
      encodeResponseParam(200, 'OK'),
      encodeTopicNameParam('foo/bar'),
    ]);
    const msg = decodeSmf(encodeSmfFrame({ protocol: SmfProtocol.SMP, ttl: 1 }, params));
    expect(msg.params.correlationTag).toBe(0xabcdef);
    expect(msg.params.responseCode).toBe(200);
    expect(msg.params.responseString).toBe('OK');
    expect(msg.params.topicName?.toString()).toBe('foo/bar');
  });

  it('uses extended length form for values over 253 bytes', () => {
    const topic = 'x'.repeat(300);
    const frame = encodeSmfFrame(
      { protocol: SmfProtocol.TRMSG, ttl: 1 },
      encodeTopicNameParam(topic),
    );
    // byte 12 is the param type byte; byte 13 must be 0 (extended form marker)
    expect(frame.readUInt8(13)).toBe(0);
    expect(frame.readUInt32BE(14)).toBe(306);
    expect(decodeSmf(frame).params.topicName?.toString()).toBe(topic);
  });

  it('decodes base64 username/password params', () => {
    const params = Buffer.concat([
      encodeSmfParam(0, 0x06, Buffer.from(Buffer.from('user1').toString('base64'), 'latin1')),
      encodeSmfParam(0, 0x07, Buffer.from(Buffer.from('pw').toString('base64'), 'latin1')),
    ]);
    const msg = decodeSmf(encodeSmfFrame({ protocol: SmfProtocol.CLIENTCTRL, ttl: 1 }, params));
    expect(msg.params.username).toBe('user1');
    expect(msg.params.password).toBe('pw');
  });

  it('skips unknown params and stops at padding', () => {
    const unknown = encodeSmfParam(0, 0x0d, Buffer.from('whatever'));
    const params = Buffer.concat([
      unknown,
      encodeResponseParam(200, 'OK'),
      Buffer.from([0x00, 0x00]), // padding terminates the loop
    ]);
    const msg = decodeSmf(encodeSmfFrame({ protocol: SmfProtocol.SMP, ttl: 1 }, params));
    expect(msg.params.responseCode).toBe(200);
  });
});

describe('SMP', () => {
  it('round-trips add-subscription', () => {
    const frame = encodeSmpRequest(
      {
        msgType: SmpMsgType.ADDSUBSCRIPTION,
        flags: SmpFlags.TOPIC | SmpFlags.RESPREQUIRED,
        subscription: 'a/b/>',
      },
      42,
    );
    const msg = decodeSmf(frame);
    expect(msg.header.protocol).toBe(SmfProtocol.SMP);
    expect(msg.params.correlationTag).toBe(42);
    const smp = decodeSmp(msg.payload);
    expect(smp.msgType).toBe(SmpMsgType.ADDSUBSCRIPTION);
    expect(smp.subscription).toBe('a/b/>');
    expect(smp.flags & SmpFlags.RESPREQUIRED).toBeTruthy();
  });

  it('round-trips queue subscription with queue name', () => {
    const frame = encodeSmpRequest({
      msgType: SmpMsgType.ADDQUEUESUBSCRIPTION,
      flags: SmpFlags.TOPIC,
      subscription: 'orders/>',
      queueName: 'q/orders',
    });
    const smp = decodeSmp(decodeSmf(frame).payload);
    expect(smp.queueName).toBe('q/orders');
    expect(smp.subscription).toBe('orders/>');
  });

  it('builds a response with echoed body, corrtag and response code', () => {
    const req = {
      msgType: SmpMsgType.ADDSUBSCRIPTION,
      flags: SmpFlags.TOPIC | SmpFlags.RESPREQUIRED,
      subscription: 'x/y',
    } as const;
    const frame = encodeSmpResponse(req, 7, 200, 'OK');
    const msg = decodeSmf(frame);
    expect(msg.params.correlationTag).toBe(7);
    expect(msg.params.responseCode).toBe(200);
    expect(decodeSmp(msg.payload).subscription).toBe('x/y');
  });
});

describe('ClientCtrl', () => {
  it('round-trips a login response through our decoder', () => {
    const frame = encodeLoginResponse({
      responseCode: 200,
      responseText: 'OK',
      clientName: 'client-1',
      vpnName: 'default',
      p2pTopicBase: '#P2P/v:mock/abc/client-1',
      virtualRouterName: 'v:mock',
      physicalRouterName: 'mock-router',
      capabilities: { booleanBits: [14], maxDirectMsgSize: 64 * 1024 * 1024 },
      keepAliveIntervalSec: 3,
    });
    const msg = decodeSmf(frame);
    expect(msg.header.protocol).toBe(SmfProtocol.CLIENTCTRL);
    expect(msg.params.responseCode).toBe(200);
    const cc = decodeClientCtrl(msg.payload);
    expect(cc.msgType).toBe(0);
    expect(cc.params.get(0x05)?.toString()).toBe('client-1\0');
    expect(cc.params.get(0x08)?.toString()).toBe('#P2P/v:mock/abc/client-1\0');
    const caps = cc.params.get(0x09)!;
    expect(caps.readUInt8(0)).toBe(27); // boolean cap bit count
    expect(caps.readUInt8(1)).toBe(0x00); // bits 0-7 all off (no GM)
    expect(caps.readUInt8(2) & 0x02).toBe(0x02); // bit 14 (NO_LOCAL) set
  });

  it('parses a login request the way the SDK encodes it', () => {
    // Hand-built per docs/protocol-notes.md §5: version 1, msgType 0,
    // params CLIENTNAME + MSGVPNNAME + KEEP_ALIVE_INTERVAL.
    const name = Buffer.from('my-client\0');
    const vpn = Buffer.from('default\0');
    const ka = Buffer.from([0, 0, 0, 3]);
    const params = Buffer.concat([
      Buffer.concat([Buffer.from([0x05]), u32(name.length + 5), name]),
      Buffer.concat([Buffer.from([0x86]), u32(vpn.length + 5), vpn]), // UH=1 | type 0x06
      Buffer.concat([Buffer.from([0x18]), u32(ka.length + 5), ka]),
    ]);
    const body = Buffer.alloc(6 + params.length);
    body.writeUInt16BE(0x0100, 0);
    body.writeUInt32BE(body.length, 2);
    params.copy(body, 6);

    const cc = decodeClientCtrl(body);
    const login = parseLoginRequest(cc);
    expect(login.clientName).toBe('my-client');
    expect(login.vpnName).toBe('default');
    expect(login.keepAliveIntervalSec).toBe(3);
  });
});

describe('TrMsg', () => {
  it('extracts topic and payload from a direct message', () => {
    const frame = encodeDirectMessage('animals/cat', Buffer.from('meow'));
    const dm = trMsgFromSmf(decodeSmf(frame))!;
    expect(dm.topic).toBe('animals/cat');
    expect(dm.payload.toString()).toBe('meow');
    expect(dm.raw).toEqual(frame);
  });
});

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}
