import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { IlexMark } from './ilex-mark';
import { MARK_PATH } from './ilex-mark.constants';

describe('IlexMark', () => {
  it('draws the mark from brand/ (the generator is the source)', () => {
    const svg = readFileSync(resolve(process.cwd(), '../../brand/ilexarium-mark.svg'), 'utf8');
    expect(svg).toContain(`d="${MARK_PATH}"`);
  });

  it('is decorative and follows the text colour', async () => {
    const fixture = TestBed.createComponent(IlexMark);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
  });
});
