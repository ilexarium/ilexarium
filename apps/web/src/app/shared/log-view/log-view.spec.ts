import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LOG_LIMITS, type LogLine } from '@ilex/shared';
import { stubLocalStorage, stubScreenWidth } from '../../layout/testing';
import { formatLogTime } from '../../shared/format/format';
import { LOG_TIMESTAMPS_KEY, LOG_WRAP_KEY } from './log-preferences.constants';
import { LogView } from './log-view';
import type { LogViewEntry } from './log-view.model';

let nextId = 0;
function entry(text: string, stream: LogLine['stream'] = 'stdout'): LogViewEntry {
  const id = nextId++;
  const at = `2026-10-11T12:00:00.${String(id).padStart(9, '0')}Z`;
  return { id, at, stream, text };
}

@Component({
  imports: [LogView],
  template: `<ilex-log-view [entries]="entries()" />`,
})
class Host {
  readonly entries = signal<LogViewEntry[]>([]);
}

/** jsdom has no layout: gives the log box a size and a working scroll position. */
function layOut(box: HTMLElement, { height = 200, contentHeight = 1000 } = {}) {
  let top = 0;
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => height });
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => contentHeight });
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => (top = Math.max(0, Math.min(value, contentHeight - height))),
  });
  return {
    /** Scrolls like a user would (the scroll event follows). */
    scrollTo(value: number) {
      box.scrollTop = value;
      box.dispatchEvent(new Event('scroll'));
    },
  };
}

describe('LogView', () => {
  let storage: ReturnType<typeof stubLocalStorage>;
  let restoreScreen: () => void;

  beforeEach(() => {
    storage = stubLocalStorage();
    restoreScreen = stubScreenWidth(1280);
  });
  afterEach(() => {
    storage.restore();
    restoreScreen();
  });

  async function render(entries: LogViewEntry[] = []) {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.entries.set(entries);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const box = el.querySelector<HTMLElement>('ol')!;
    return {
      fixture,
      el,
      box,
      lines: () => [...box.querySelectorAll('li')],
      button: (name: string) =>
        [...el.querySelectorAll<HTMLButtonElement>('button')].find(
          (b) => b.textContent!.replace(/\s+/g, ' ').trim() === name,
        ),
      async set(next: LogViewEntry[]) {
        fixture.componentInstance.entries.set(next);
        await fixture.whenStable();
      },
      async filter(text: string) {
        const input = el.querySelector<HTMLInputElement>('input[type="search"]')!;
        input.value = text;
        input.dispatchEvent(new Event('input'));
        await fixture.whenStable();
      },
    };
  }

  it('shows each line as text — never as HTML', async () => {
    const { lines } = await render([entry('plain'), entry('<img src=x onerror=alert(1)>')]);
    expect(lines()).toHaveLength(2);
    expect(lines()[1].textContent).toContain('<img src=x onerror=alert(1)>');
    expect(lines()[1].querySelector('img')).toBeNull();
  });

  it('marks stderr lines with an icon and the word, not colour alone', async () => {
    const { lines } = await render([entry('fine'), entry('broken', 'stderr')]);
    expect(lines()[0].textContent).not.toContain('stderr');
    expect(lines()[1].textContent).toContain('stderr');
    // The channel, not an error: no tinted line (many services log everything to stderr).
    expect(lines()[1].className).not.toContain('destructive');
    expect(lines()[1].querySelector('ng-icon[name="lucideTriangleAlert"]')).not.toBeNull();
  });

  it('keeps log lines left to right, even in a right-to-left language', async () => {
    const { box, el } = await render([entry('a')]);
    expect(box.getAttribute('dir')).toBe('ltr');
    expect(el.querySelector('#log-filter')!.getAttribute('dir')).toBe('auto');
  });

  it('is a labelled, keyboard-scrollable box; lines skip rendering off screen', async () => {
    const { box, lines } = await render([entry('a')]);
    expect(box.getAttribute('aria-label')).toBe('Log lines');
    expect(box.getAttribute('tabindex')).toBe('0');
    expect(box.className).toContain('overflow-auto');
    expect(lines()[0].className).toContain('[content-visibility:auto]');
  });

  describe('timestamps', () => {
    it('shows local times by default; the toggle hides them and is remembered', async () => {
      const line = entry('a');
      const { fixture, lines, button } = await render([line]);
      const time = lines()[0].querySelector('time')!;
      expect(time.textContent).toBe(formatLogTime(line.at));
      expect(time.getAttribute('datetime')).toBe(line.at);

      const toggle = button('Timestamps')!;
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      toggle.click();
      await fixture.whenStable();
      expect(lines()[0].querySelector('time')).toBeNull();
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(storage.storage.getItem(LOG_TIMESTAMPS_KEY)).toBe('false');
    });

    it('starts from the remembered choice', async () => {
      storage.storage.setItem(LOG_TIMESTAMPS_KEY, 'false');
      const { lines } = await render([entry('a')]);
      expect(lines()[0].querySelector('time')).toBeNull();
    });
  });

  describe('wrap', () => {
    const textOf = (li: HTMLElement) => li.querySelector('span:last-child')!;

    it('is off by default on large screens: long lines scroll sideways inside the box', async () => {
      const { lines, button } = await render([entry('x'.repeat(500))]);
      expect(button('Wrap lines')!.getAttribute('aria-pressed')).toBe('false');
      expect(textOf(lines()[0]).className).toContain('whitespace-pre');
      expect(lines()[0].className).toContain('w-max');
    });

    it('is on by default on phones', async () => {
      restoreScreen();
      restoreScreen = stubScreenWidth(375);
      const { lines, button } = await render([entry('x'.repeat(500))]);
      expect(button('Wrap lines')!.getAttribute('aria-pressed')).toBe('true');
      expect(textOf(lines()[0]).className).toContain('whitespace-pre-wrap');
      expect(textOf(lines()[0]).className).toContain('wrap-anywhere');
      expect(lines()[0].className).not.toContain('w-max');
    });

    it('toggles and is remembered, over the screen-size default', async () => {
      const { fixture, lines, button } = await render([entry('a')]);
      button('Wrap lines')!.click();
      await fixture.whenStable();
      expect(textOf(lines()[0]).className).toContain('whitespace-pre-wrap');
      expect(storage.storage.getItem(LOG_WRAP_KEY)).toBe('true');
    });

    it('works without storage (blocked or private mode)', async () => {
      storage.restore();
      storage = stubLocalStorage({ blocked: true });
      const { fixture, lines, button } = await render([entry('a')]);
      button('Wrap lines')!.click();
      await fixture.whenStable();
      expect(textOf(lines()[0]).className).toContain('whitespace-pre-wrap');
    });
  });

  describe('filter', () => {
    it('shows matching lines only, ignoring case, and says how many', async () => {
      const { el, lines, filter } = await render([
        entry('GET /health 200'),
        entry('get /api 500', 'stderr'),
        entry('started'),
      ]);
      await filter('get');
      expect(lines().map((li) => li.textContent)).toEqual([
        expect.stringContaining('GET /health 200'),
        expect.stringContaining('get /api 500'),
      ]);
      expect(el.textContent).toContain('2 of 3 lines match');
    });

    it('says when nothing matches, and shows everything again when cleared', async () => {
      const { lines, filter } = await render([entry('a'), entry('b')]);
      await filter('zzz');
      expect(lines().map((li) => li.textContent!.trim())).toEqual(['No lines match “zzz”.']);
      await filter('');
      expect(lines()).toHaveLength(2);
    });

    it('applies to new lines as they come', async () => {
      const first = [entry('error one'), entry('ok')];
      const { lines, filter, set } = await render(first);
      await filter('error');
      await set([...first, entry('error two'), entry('fine')]);
      expect(lines()).toHaveLength(2);
    });
  });

  describe('following', () => {
    it('keeps the newest line in view while at the bottom', async () => {
      const { box, set } = await render([entry('a')]);
      layOut(box);
      await set([entry('a'), entry('b')]);
      expect(box.scrollTop).toBe(800);
    });

    it('stops when scrolled up, offers Jump to latest, and follows again from there', async () => {
      const first = [entry('a')];
      const { box, set, button } = await render(first);
      const view = layOut(box);
      await set([...first, entry('b')]);
      view.scrollTo(100);
      await set([...first, entry('b'), entry('c')]);
      expect(box.scrollTop).toBe(100);

      button('Jump to latest')!.click();
      await set([...first, entry('b'), entry('c'), entry('d')]);
      expect(box.scrollTop).toBe(800);
      expect(button('Jump to latest')).toBeUndefined();
    });

    it('follows again when scrolled back to the bottom by hand', async () => {
      const { box, set, button, fixture } = await render([entry('a')]);
      const view = layOut(box);
      view.scrollTo(100);
      await fixture.whenStable();
      expect(button('Jump to latest')).toBeDefined();
      view.scrollTo(800);
      await set([entry('a'), entry('b')]);
      expect(button('Jump to latest')).toBeUndefined();
    });

    it('stops with Pause and starts again with Resume', async () => {
      const { box, set, button, fixture } = await render([entry('a')]);
      layOut(box);
      box.scrollTop = 300; // where the reader is
      const pause = button('Pause')!;
      pause.click();
      await fixture.whenStable();
      expect(pause.getAttribute('aria-pressed')).toBe('true');
      await set([entry('a'), entry('b')]);
      expect(box.scrollTop).toBe(300);

      button('Resume')!.click();
      await fixture.whenStable();
      expect(box.scrollTop).toBe(800);
      expect(button('Pause')!.getAttribute('aria-pressed')).toBe('false');
    });
  });

  it('renders 10,000 lines, and adds a batch without re-creating the lines it has', async () => {
    const many = Array.from({ length: LOG_LIMITS.maxLinesInView }, (_, i) => entry(`line ${i}`));
    const { lines, set } = await render(many);
    expect(lines()).toHaveLength(LOG_LIMITS.maxLinesInView);
    const kept = lines()[5000];
    await set([...many.slice(10), ...Array.from({ length: 10 }, (_, i) => entry(`new ${i}`))]);
    expect(lines()).toHaveLength(LOG_LIMITS.maxLinesInView);
    expect(lines()[4990]).toBe(kept);
  });

  it('labels the toolbar buttons for screen readers on phones, where only icons show', async () => {
    const { el } = await render();
    const labels = [...el.querySelectorAll('[role="toolbar"] button span')].map((s) => ({
      text: s.textContent!.trim(),
      className: s.className,
    }));
    expect(labels.map((l) => l.text)).toEqual(['Pause', 'Timestamps', 'Wrap lines']);
    for (const label of labels) expect(label.className).toContain('sr-only sm:not-sr-only');
    expect(el.querySelector('label[for="log-filter"]')!.textContent).toBe('Filter lines');
  });
});
