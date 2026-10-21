import { Marked, type Tokens } from 'marked';
import { escapeHtml as escape } from '../../../shared/format/escape-html';

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    // Raw HTML in an answer is shown as the text it is, never as HTML.
    html: ({ text }: Tokens.HTML | Tokens.Tag) => escape(text),
    // No image is loaded from an answer: it becomes a link to it.
    image: ({ href, text }: Tokens.Image) =>
      `<a href="${escape(href)}">${escape(text || href)}</a>`,
  },
});

/** Markdown to HTML, for Angular's sanitiser to check (`MarkdownView`). */
export function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}
