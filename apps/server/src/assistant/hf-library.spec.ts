import { HfLibrary } from './hf-library.js';

/** Stands in for `fetch`, answering by URL; every URL asked is recorded. */
function stubFetch(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      const key = Object.keys(answers).find((prefix) => url.startsWith(prefix));
      if (!key) throw new TypeError('fetch failed');
      return answers[key]();
    }),
  );
  return asked;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const SEARCH = 'https://huggingface.co/api/models?';
const DETAIL = 'https://huggingface.co/api/models/bartowski/SmolLM2-135M-Instruct-GGUF?blobs=true';

describe('HfLibrary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('searches GGUF models, most downloaded first, on huggingface.co only', async () => {
    const asked = stubFetch({
      [SEARCH]: () =>
        json([
          {
            id: 'bartowski/SmolLM2-135M-Instruct-GGUF',
            downloads: 52592,
            likes: 18,
            lastModified: '2024-11-01T00:00:00.000Z',
          },
          { id: 'someone/other', extra: 'ignored' },
        ]),
    });
    const library = await new HfLibrary().search('smollm 2');
    expect(library.models).toEqual([
      {
        id: 'bartowski/SmolLM2-135M-Instruct-GGUF',
        downloads: 52592,
        likes: 18,
        updatedAt: '2024-11-01T00:00:00.000Z',
      },
      { id: 'someone/other', downloads: 0, likes: 0, updatedAt: null },
    ]);
    const url = new URL(asked[0]);
    expect(url.origin + url.pathname).toBe('https://huggingface.co/api/models');
    expect(url.searchParams.get('search')).toBe('smollm 2');
    expect(url.searchParams.get('filter')).toBe('gguf');
  });

  it('lists the sizes a repository offers, smallest first, as names Ollama downloads', async () => {
    stubFetch({
      [DETAIL]: () =>
        json({
          id: 'bartowski/SmolLM2-135M-Instruct-GGUF',
          gated: false,
          cardData: { license: 'apache-2.0' },
          siblings: [
            { rfilename: 'README.md', size: 10 },
            { rfilename: 'SmolLM2-135M-Instruct-Q8_0.gguf', size: 145_000_000 },
            { rfilename: 'SmolLM2-135M-Instruct-Q4_K_M.gguf', size: 105_000_000 },
            { rfilename: 'SmolLM2-135M-Instruct-f16.gguf', size: 270_000_000 },
            { rfilename: 'big-Q4_K_M-00001-of-00002.gguf', size: 1 },
            { rfilename: 'SmolLM2-135M-Instruct.imatrix', size: 1 },
          ],
        }),
    });
    const detail = await new HfLibrary().detail('bartowski', 'SmolLM2-135M-Instruct-GGUF');
    expect(detail).toEqual({
      id: 'bartowski/SmolLM2-135M-Instruct-GGUF',
      gated: false,
      license: 'apache-2.0',
      files: [
        {
          quantization: 'Q4_K_M',
          sizeBytes: 105_000_000,
          model: 'hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M',
        },
        {
          quantization: 'Q8_0',
          sizeBytes: 145_000_000,
          model: 'hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:Q8_0',
        },
        {
          quantization: 'f16',
          sizeBytes: 270_000_000,
          model: 'hf.co/bartowski/SmolLM2-135M-Instruct-GGUF:f16',
        },
      ],
    });
  });

  it('says a gated model is gated (Ollama can’t download it)', async () => {
    stubFetch({ [DETAIL]: () => json({ id: 'x/y', gated: 'manual', siblings: [] }) });
    expect((await new HfLibrary().detail('bartowski', 'SmolLM2-135M-Instruct-GGUF')).gated).toBe(
      true,
    );
  });

  it.each([
    ['not found', () => json({ error: 'Repository not found' }, 404), 'library_not_found'],
    ['a server error', () => json({}, 500), 'library_unreachable'],
    ['an unexpected answer', () => json({ id: 3 }), 'library_unreachable'],
    ['not JSON', () => new Response('<html>'), 'library_unreachable'],
    ['too big', () => new Response('['.padEnd(3 * 1024 * 1024, ' ')), 'library_unreachable'],
  ])('answers %s with a code', async (_, answer, code) => {
    stubFetch({ [DETAIL]: answer });
    await expect(
      new HfLibrary().detail('bartowski', 'SmolLM2-135M-Instruct-GGUF'),
    ).rejects.toMatchObject({
      response: { code },
    });
  });

  it('says so when Hugging Face is not reachable', async () => {
    stubFetch({});
    await expect(new HfLibrary().search('x')).rejects.toMatchObject({
      response: { code: 'library_unreachable' },
    });
  });

  it('asks again only after a few minutes', async () => {
    const asked = stubFetch({ [SEARCH]: () => json([]) });
    const library = new HfLibrary();
    await library.search('a');
    await library.search('a');
    expect(asked).toHaveLength(1);
  });
});
