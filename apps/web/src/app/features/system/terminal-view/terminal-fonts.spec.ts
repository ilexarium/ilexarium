import { loadTerminalFonts } from './terminal-fonts';
import { SYMBOLS_FONT_FAMILY, SYMBOLS_FONT_URL } from './terminal-view.constants';

describe('loadTerminalFonts', () => {
  const added: { family: string; source: string }[] = [];
  let failLoad = false;

  beforeEach(() => {
    added.length = 0;
    failLoad = false;
    vi.stubGlobal(
      'FontFace',
      class {
        constructor(
          readonly family: string,
          readonly source: string,
        ) {}
        load = () => (failLoad ? Promise.reject(new Error('offline')) : Promise.resolve(this));
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  function fakeDocument(load: (font: string) => Promise<unknown>): Document {
    return { fonts: { add: (face: (typeof added)[number]) => added.push(face), load } } as never;
  }

  it('registers the symbols font once and waits for the fonts', async () => {
    const loaded: string[] = [];
    const document = fakeDocument(async (font) => loaded.push(font));
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
    failLoad = true;
    await expect(
      loadTerminalFonts(fakeDocument(() => Promise.reject(new Error('offline')))),
    ).resolves.toBeUndefined();
  });

  it('does nothing without the font loading API', async () => {
    await expect(loadTerminalFonts({} as Document)).resolves.toBeUndefined();
  });
});
