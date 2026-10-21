import { escapeHtml } from './escape-html';

describe('escapeHtml', () => {
  it('escapes everything that could open a tag or end an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('escapes & first, so entities already there stay visible as text', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
