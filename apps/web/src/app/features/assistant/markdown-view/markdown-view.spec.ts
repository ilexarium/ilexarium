import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MarkdownView } from './markdown-view';

@Component({
  imports: [MarkdownView],
  template: `<app-markdown-view [text]="text()" />`,
})
class Host {
  readonly text = signal('');
}

describe('MarkdownView', () => {
  async function render(text: string) {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.text.set(text);
    await fixture.whenStable();
    return fixture.nativeElement.querySelector('app-markdown-view') as HTMLElement;
  }

  it('renders Markdown: emphasis, lists, code', async () => {
    const el = await render('**Bold** and `code`\n\n- one\n- two\n\n```\nls -la\n```');
    expect(el.querySelector('strong')?.textContent).toBe('Bold');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('pre code')?.textContent).toContain('ls -la');
  });

  it('never runs what an answer contains', async () => {
    const el = await render(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))\n\n<b onclick="x()">b</b>',
    );
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    // Shown as text (escaped), never as attributes.
    const handlers = [...el.querySelectorAll('*')].flatMap((node) =>
      [...node.attributes].filter((attribute) => attribute.name.startsWith('on')),
    );
    expect(handlers).toEqual([]);
    expect(el.querySelector('a')?.getAttribute('href') ?? '').not.toMatch(/^javascript:/);
    // The raw HTML is shown as text.
    expect(el.textContent).toContain('<script>alert(1)</script>');
  });

  it('turns images into links, so no outside address is loaded', async () => {
    const el = await render('![a cat](https://example.com/cat.png)');
    expect(el.querySelector('img')).toBeNull();
    const link = el.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/cat.png');
    expect(link.textContent).toBe('a cat');
  });

  it('opens links in a new tab without handing over the app', async () => {
    const el = await render('[docs](https://ollama.com)');
    const link = el.querySelector('a')!;
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('gives each code block a copy button', async () => {
    const el = await render('```\none\n```\n\n```\ntwo\n```');
    expect(el.querySelectorAll('pre button')).toHaveLength(2);
    expect(el.querySelector('pre button')?.textContent).toBe('Copy');
  });
});
