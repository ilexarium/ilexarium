import { FONT_WAIT_MS, SYMBOLS_FONT_FAMILY, SYMBOLS_FONT_URL } from './terminal-view.constants';

describe('loadTerminalFonts', () => {
  let added: FakeFontFace[];
  let deleted: FakeFontFace[];
  let symbolsLoad: () => Promise<unknown>;

  class FakeFontFace {
    status: FontFaceLoadStatus = 'unloaded';
    constructor(
      readonly family: string,
      readonly source: string,
    ) {}
    load = async () => {
      try {
        await symbolsLoad();
        this.status = 'loaded';
      } catch (error) {
        this.status = 'error';
        throw error;
      }
    };
  }

  beforeEach(() => {
    added = [];
    deleted = [];
    symbolsLoad = () => Promise.resolve();
    vi.stubGlobal('FontFace', FakeFontFace);
    // The module remembers its symbols font: a fresh copy for every test.
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function load(document: Document) {
    const { loadTerminalFonts } = await import('./terminal-fonts');
    return loadTerminalFonts(document);
  }

  function fakeDocument(fontLoad: (font: string) => Promise<unknown>): Document {
    return {
      fonts: {
        add: (face: FakeFontFace) => added.push(face),
        delete: (face: FakeFontFace) => deleted.push(face),
        load: fontLoad,
      },
    } as never;
  }

  it('registers the symbols font once and waits for the fonts', async () => {
    const loaded: string[] = [];
    const document = fakeDocument(async (font) => loaded.push(font));
    const { loadTerminalFonts } = await import('./terminal-fonts');
    await loadTerminalFonts(document);
    await loadTerminalFonts(document);
    expect(added).toEqual([
      expect.objectContaining({
        family: SYMBOLS_FONT_FAMILY,
        source: expect.stringContaining(SYMBOLS_FONT_URL),
      }),
    ]);
    expect(loaded).toContain("14px 'JetBrains Mono'");
  });

  it('never fails: the terminal opens with the fallback fonts', async () => {
    symbolsLoad = () => Promise.reject(new Error('offline'));
    await expect(
      load(fakeDocument(() => Promise.reject(new Error('offline')))),
    ).resolves.toBeUndefined();
  });

  it('tries a symbols font that failed again the next time', async () => {
    symbolsLoad = () => Promise.reject(new Error('offline'));
    const document = fakeDocument(async () => undefined);
    const { loadTerminalFonts } = await import('./terminal-fonts');
    await loadTerminalFonts(document);
    symbolsLoad = () => Promise.resolve();
    await loadTerminalFonts(document);
    expect(deleted).toEqual([added[0]]);
    expect(added).toHaveLength(2);
    expect(added[1].status).toBe('loaded');
  });

  it(`waits at most ${FONT_WAIT_MS} ms (the terminal's ticket is short-lived)`, async () => {
    vi.useFakeTimers();
    symbolsLoad = () => new Promise(() => undefined);
    let done = false;
    void load(fakeDocument(() => new Promise(() => undefined))).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(FONT_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('does nothing without the font loading API', async () => {
    await expect(load({} as Document)).resolves.toBeUndefined();
  });
});
