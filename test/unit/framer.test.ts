import { describe, expect, it } from 'vitest';
import { SmfFramer } from '../../src/transport/framer.js';
import { encodeKeepAlive } from '../../src/smf/messages/keepalive.js';
import { encodeDirectMessage } from '../../src/smf/messages/trmsg.js';

function collect(): { frames: Buffer[]; errors: Error[]; framer: SmfFramer } {
  const frames: Buffer[] = [];
  const errors: Error[] = [];
  const framer = new SmfFramer(
    (f) => frames.push(Buffer.from(f)),
    (e) => errors.push(e),
  );
  return { frames, errors, framer };
}

describe('SmfFramer', () => {
  const ka = encodeKeepAlive();
  const msg = encodeDirectMessage('a/b/c', Buffer.from('hello'));

  it('emits a single complete frame', () => {
    const { frames, framer } = collect();
    framer.push(ka);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(ka);
  });

  it('reassembles a frame split across chunks (including mid-header)', () => {
    const { frames, framer } = collect();
    framer.push(msg.subarray(0, 3));
    expect(frames).toHaveLength(0);
    framer.push(msg.subarray(3, 17));
    expect(frames).toHaveLength(0);
    framer.push(msg.subarray(17));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(msg);
  });

  it('splits multiple frames in one chunk', () => {
    const { frames, framer } = collect();
    framer.push(Buffer.concat([ka, msg, ka]));
    expect(frames).toHaveLength(3);
    expect(frames[1]).toEqual(msg);
  });

  it('handles back-to-back frames with a trailing partial', () => {
    const { frames, framer } = collect();
    framer.push(Buffer.concat([msg, ka.subarray(0, 5)]));
    expect(frames).toHaveLength(1);
    framer.push(ka.subarray(5));
    expect(frames).toHaveLength(2);
  });

  it('reports lost framing on bad version', () => {
    const { frames, errors, framer } = collect();
    const bad = Buffer.from(ka);
    bad[0] = 0x07;
    framer.push(bad);
    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('rejects oversized messages', () => {
    const errors: Error[] = [];
    const framer = new SmfFramer(
      () => {},
      (e) => errors.push(e),
      1024,
    );
    const big = encodeDirectMessage('t', Buffer.alloc(4096));
    framer.push(big);
    expect(errors).toHaveLength(1);
  });
});
