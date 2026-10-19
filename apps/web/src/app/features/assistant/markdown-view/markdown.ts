import { Marked, type Tokens } from 'marked';

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

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
