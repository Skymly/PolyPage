import { afterEach, expect, it, vi } from 'vitest';
import { listProviderModels } from '../src/providers/modelCatalog';
import { defaultProvider } from '../src/shared/constants';

afterEach(() => vi.unstubAllGlobals());

it('loads a compatible catalog using the service base URL and the entered API key', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [
    { id: 'translator', display_name: 'Text model' },
    { id: 'translator' },
    { id: 'images', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
  ] }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(listProviderModels({
    ...defaultProvider(), apiKey: ' key ', baseUrl: 'https://gateway.example/api/v1/?api-version=1#options',
    headers: { 'X-Workspace': 'example' },
  })).resolves.toEqual([{ id: 'translator', name: 'Text model' }]);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://gateway.example/api/v1/models?api-version=1');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key');
  expect(new Headers(init?.headers).get('X-Workspace')).toBe('example');
  expect(init?.redirect).toBe('error');
});

it('queries a keyless local endpoint and reports that a missing catalog can be bypassed with manual entry', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(listProviderModels({ ...defaultProvider(), baseUrl: 'http://localhost:11434/v1' }))
    .rejects.toMatchObject({ kind: 'config', message: expect.stringContaining('没有模型列表接口') });
  expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/models');
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
});
