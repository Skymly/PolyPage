/**
 * OCR privilege gates (M-06): isTrusted, URL origin, fetch limits.
 */
import { describe, expect, it, vi } from 'vitest';
import { isTrustedGesture, ocrRequestAllowed } from '../src/shared/imageAccess';
import { IMAGE_MAX_BYTES } from '../src/shared/constants';
import { defaultFetchImage } from '../src/ocr/imagePrep';

describe('ocrRequestAllowed (M-06)', () => {
  it('rejects a cross-origin image when there is no user gesture', () => {
    expect(
      ocrRequestAllowed({
        imageUrl: 'https://evil.test/secret.png',
        tabUrl: 'https://news.example/page',
        userGesture: false,
      }),
    ).toBe(false);
  });

  it('allows same-origin images without a gesture', () => {
    expect(
      ocrRequestAllowed({
        imageUrl: 'https://news.example/pic.png',
        tabUrl: 'https://news.example/page',
        userGesture: false,
      }),
    ).toBe(true);
  });

  it('allows a cross-origin image after a user gesture (context menu / trusted click)', () => {
    expect(
      ocrRequestAllowed({
        imageUrl: 'https://cdn.example/hotlink.png',
        tabUrl: 'https://news.example/page',
        userGesture: true,
      }),
    ).toBe(true);
  });

  it('allows data URLs and extension-page senders', () => {
    expect(ocrRequestAllowed({ imageUrl: 'data:image/png;base64,aa', userGesture: false })).toBe(true);
    expect(
      ocrRequestAllowed({
        imageUrl: 'https://cdn.example/x.png',
        senderUrl: 'chrome-extension://abcdef/viewer/pdf-viewer.html',
        userGesture: false,
      }),
    ).toBe(true);
  });
});

describe('isTrustedGesture (M-06)', () => {
  it('rejects synthesized events', () => {
    expect(isTrustedGesture(new Event('click'))).toBe(false);
    expect(isTrustedGesture({ isTrusted: true } as Event)).toBe(true);
  });
});

describe('defaultFetchImage (M-06)', () => {
  it('fetches with credentials omitted and enforces the byte cap', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/png', 'content-length': String(IMAGE_MAX_BYTES + 1) }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(defaultFetchImage('https://news.example/big.png', new AbortController().signal)).rejects.toThrow(
      /上限/,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://news.example/big.png',
      expect.objectContaining({ credentials: 'omit' }),
    );
    vi.unstubAllGlobals();
  });
});
