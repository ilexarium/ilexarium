import {
  afterRenderEffect,
  Component,
  computed,
  DOCUMENT,
  ElementRef,
  inject,
  input,
} from '@angular/core';
import { Translator } from '../../../core/i18n/translator';
import { renderMarkdown } from './markdown';

/**
 * A model's answer, from Markdown. The HTML goes through Angular's own sanitiser (`[innerHTML]`,
 * never bypassed); before that, raw HTML in the text is shown as text and images become links,
 * so an answer can neither run anything nor make the browser load outside addresses. Links open
 * in a new tab; code blocks get a copy button. Presentational.
 */
@Component({
  selector: 'laris-markdown-view',
  host: {
    class:
      'markdown block min-w-0 text-sm leading-relaxed break-words [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:ps-5 [&_pre]:relative [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:pe-10 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:ps-5 [&>*+*]:mt-3',
  },
  templateUrl: './markdown-view.html',
})
export class MarkdownView {
  readonly text = input.required<string>();

  protected readonly html = computed(() => renderMarkdown(this.text()));

  private readonly elementRef = inject(ElementRef<HTMLElement>);
  private readonly document = inject(DOCUMENT);
  private readonly translator = inject(Translator);

  constructor() {
    afterRenderEffect(() => {
      this.html();
      const root = this.elementRef.nativeElement as HTMLElement;
      for (const link of root.querySelectorAll('a')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      for (const pre of root.querySelectorAll('pre')) {
        if (pre.querySelector('button')) continue;
        pre.append(this.copyButton(pre));
      }
    });
  }

  private copyButton(pre: HTMLElement): HTMLButtonElement {
    const button = this.document.createElement('button');
    button.type = 'button';
    button.className =
      'absolute end-1.5 top-1.5 rounded-md border bg-background px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground';
    button.textContent = this.translator.t('assistant.copy');
    button.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent ?? '';
      void this.document.defaultView?.navigator.clipboard?.writeText(code).then(() => {
        button.textContent = this.translator.t('assistant.copied');
      });
    });
    return button;
  }
}
