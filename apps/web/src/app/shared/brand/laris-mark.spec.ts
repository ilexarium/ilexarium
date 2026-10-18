import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { LarisMark } from './laris-mark';
import { MARK_PATH } from './laris-mark.constants';

describe('LarisMark', () => {
  it('draws the mark from brand/ (the generator is the source)', () => {
    const svg = readFileSync(resolve(process.cwd(), '../../brand/laris-mark.svg'), 'utf8');
    expect(svg).toContain(`d="${MARK_PATH}"`);
  });

  it('is decorative and follows the text colour', async () => {
    const fixture = TestBed.createComponent(LarisMark);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
  });
});
