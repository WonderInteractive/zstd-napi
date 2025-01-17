/* eslint jest/no-done-callback: 0 */
import { randomBytes } from 'crypto';
import * as binding from '../binding';
import {
  Compressor,
  CompressParameters,
  Decompressor,
  DecompressStream,
} from '../lib';

const mockBinding: jest.Mocked<typeof binding> =
  jest.createMockFromModule('../binding');

function compress(
  input: Uint8Array,
  params: Partial<CompressParameters> = {},
): Buffer {
  const compressor = new Compressor();
  compressor.setParameters(params);
  return compressor.compress(input);
}

describe('Decompressor', () => {
  let decompressor: Decompressor;

  beforeEach(() => {
    jest.clearAllMocks();
    decompressor = new Decompressor();
  });

  test('#decompress handles frames with content size', () => {
    const original = Buffer.from('hello');
    const input = compress(Buffer.from('hello'));
    expect(binding.getFrameContentSize(input)).toBe(original.length);
    expect(decompressor.decompress(input).equals(original)).toBe(true);
  });

  test('#decompress handles frames without content size', () => {
    const original = Buffer.from('hello');
    const input = compress(Buffer.from('hello'), { contentSizeFlag: false });
    expect(binding.getFrameContentSize(input)).toBeNull();
    expect(decompressor.decompress(input).equals(original)).toBe(true);
  });

  test('#decompress decompresses all frames in input', () => {
    const originals = [Buffer.from('hello'), Buffer.from(' world')];
    const frames = originals.map((b) =>
      compress(b, { contentSizeFlag: false }),
    );
    const input = Buffer.concat(frames);
    const expected = Buffer.concat(originals);
    expect(decompressor.decompress(input).equals(expected)).toBe(true);
  });

  test('#decompress handles large inputs without content size', () => {
    // 1MiB of random data with roughly 2x compression ratio
    const chunks = [];
    for (let i = 0; i < 1024; i++) {
      const chunk = randomBytes(1024);
      chunks.push(chunk, chunk);
    }
    const original = Buffer.concat(chunks);
    const input = compress(original, { contentSizeFlag: false });
    expect(original.length / input.length).toBeCloseTo(2, 1);
    expect(decompressor.decompress(input).equals(original)).toBe(true);
  });

  test('#decompress handles high-ratio inputs without content size', () => {
    // 1MiB of zeros, which has a very high compression ratio
    const original = Buffer.alloc(1024 * 1024);
    const input = compress(original, { contentSizeFlag: false });
    expect(input.length).toBeLessThan(128);
    expect(decompressor.decompress(input).equals(original)).toBe(true);
  });

  test('#loadDictionary works', () => {
    decompressor['dctx'] = new mockBinding.DCtx();

    const dictBuf = Buffer.alloc(0);
    decompressor.loadDictionary(dictBuf);
    expect(mockBinding.DCtx.prototype.loadDictionary).toHaveBeenCalledWith(
      dictBuf,
    );
  });

  test('#setParameters resets other parameters', () => {
    decompressor['dctx'] = new mockBinding.DCtx();

    decompressor.setParameters({ windowLogMax: 10 });
    expect(mockBinding.DCtx.prototype.reset).toHaveBeenCalledWith(
      binding.ResetDirective.parameters,
    );
    expect(mockBinding.DCtx.prototype.setParameter).toHaveBeenCalledWith(
      binding.CParameter.compressionLevel,
      10,
    );
  });

  test('#updateParameters does not reset parameters', () => {
    decompressor['dctx'] = new mockBinding.DCtx();

    decompressor.updateParameters({ windowLogMax: 0 });
    expect(mockBinding.DCtx.prototype.reset).not.toHaveBeenCalled();
    expect(mockBinding.DCtx.prototype.setParameter).toHaveBeenCalled();
  });

  test('#updateParameters rejects invalid parameter names', () => {
    decompressor['dctx'] = new mockBinding.DCtx();

    expect(() => {
      // @ts-expect-error: deliberately passing wrong arguments
      decompressor.updateParameters({ invalidName: 42 });
    }).toThrowErrorMatchingInlineSnapshot(
      `"Invalid parameter name: invalidName"`,
    );
    expect(mockBinding.DCtx.prototype.setParameter).not.toHaveBeenCalled();
  });

  test('#updateParameters ignores undefined values', () => {
    decompressor['dctx'] = new mockBinding.DCtx();

    decompressor.updateParameters({ windowLogMax: undefined });
    expect(mockBinding.DCtx.prototype.setParameter).not.toHaveBeenCalled();
  });
});

describe('DecompressStream', () => {
  let stream: DecompressStream;
  let chunks: Buffer[];
  const dataHandler = jest.fn((chunk: Buffer) => chunks.push(chunk));
  const errorHandler = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    chunks = [];
    stream = new DecompressStream();
    stream.on('data', dataHandler);
    stream.on('error', errorHandler);
  });

  afterEach(() => {
    // TODO: Determine if this is supposed to be legal
    // eslint-disable-next-line jest/no-standalone-expect
    expect(errorHandler).not.toHaveBeenCalled();
  });

  test('basic functionality works', (done) => {
    const original = Buffer.from('hello');

    stream.on('end', () => {
      expect(Buffer.concat(chunks).equals(original)).toBe(true);
      return done();
    });

    stream.end(compress(original));
  });

  test('#_transform correctly propagates errors', (done) => {
    mockBinding.DCtx.prototype.decompressStream.mockImplementationOnce(() => {
      throw new Error('Simulated error');
    });
    stream['dctx'] = new mockBinding.DCtx();

    const writeCb = jest.fn();
    stream.off('error', errorHandler);
    stream.on('error', (err) => {
      expect(err).toMatchObject({ message: 'Simulated error' });
      expect(writeCb).toHaveBeenCalledWith(err);
      return done();
    });
    stream.write('', writeCb);
  });

  test('#_flush fails if in the middle of a frame', (done) => {
    const input = compress(Buffer.from('hello'));

    stream.off('error', errorHandler);
    stream.on('error', (err) => {
      expect(err).toMatchInlineSnapshot(
        `[Error: Stream ended in middle of compressed data frame]`,
      );
      return done();
    });

    stream.end(input.slice(0, input.length - 1));
  });

  test('flushes complete frames eagerly', (done) => {
    const orig1 = Buffer.from('hello');
    const orig2 = Buffer.from(' world');
    const original = Buffer.concat([orig1, orig2]);
    stream.write(compress(orig1), () => {
      expect(Buffer.concat(chunks).equals(orig1)).toBe(true);
      stream.write(compress(orig2), () => {
        expect(Buffer.concat(chunks).equals(original)).toBe(true);
        stream.end();
        return done();
      });
    });
  });

  test('handles multiple frames in single write', (done) => {
    const orig1 = Buffer.from('hello');
    const orig2 = Buffer.from(' world');
    const original = Buffer.concat([orig1, orig2]);
    stream.on('end', () => {
      expect(Buffer.concat(chunks).equals(original)).toBe(true);
      return done();
    });

    stream.end(Buffer.concat([compress(orig1), compress(orig2)]));
  });

  test('handles output that exactly matches buffer size', (done) => {
    const original = randomBytes(binding.dStreamOutSize());

    stream.on('end', () => {
      expect(Buffer.concat(chunks).equals(original)).toBe(true);
      return done();
    });

    stream.write(compress(original), () => {
      // Verify we only got one block
      expect(chunks).toHaveLength(1);
      stream.end();
    });
  });

  test('handles output larger than buffer size', (done) => {
    const original = randomBytes(binding.dStreamOutSize() + 1);

    stream.on('end', () => {
      expect(Buffer.concat(chunks).equals(original)).toBe(true);
      return done();
    });

    stream.write(compress(original), () => {
      // Verify we actually got two blocks out of one write
      expect(chunks).toHaveLength(2);
      stream.end();
    });
  });
});
