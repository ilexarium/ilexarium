import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppField } from '@laris/shared';
import { AppFields } from './app-fields';

const field = (key: string, kind: AppField['kind'], value = ''): AppField => ({
  key,
  kind,
  value,
  default: null,
  required: false,
  advanced: false,
  fromTemplate: false,
});

@Component({
  imports: [AppFields],
  template: `<laris-app-fields
    [fields]="fields()"
    [values]="values"
    (changed)="changes.push($event)"
    (kindChanged)="kinds.push($event)"
  />`,
})
class Host {
  readonly fields = signal([
    field('VERSION', 'version', '1.27'),
    field('PORT', 'port', '8088'),
    field('DATA', 'folder', './data'),
    field('ADMIN_PASSWORD', 'secret'),
  ]);
  readonly values = new Map([['PORT', '9000']]);
  readonly changes: unknown[] = [];
  readonly kinds: unknown[] = [];
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('AppFields', () => {
  it('shows each field’s guessed kind in its selector, and its value from .env first', async () => {
    const { el } = await render();
    const kinds = [...el.querySelectorAll('select')].map((s) => s.value);
    expect(kinds).toEqual(['version', 'port', 'folder', 'secret']);
    expect(el.querySelector<HTMLInputElement>('#field-PORT')!.value).toBe('9000');
    expect(el.querySelector<HTMLInputElement>('#field-ADMIN_PASSWORD')!.type).toBe('password');
  });

  it('reports a kind changed and a value edited', async () => {
    const { el, fixture } = await render();
    const select = el.querySelectorAll('select')[1];
    select.value = 'text';
    select.dispatchEvent(new Event('change'));
    const input = el.querySelector<HTMLInputElement>('#field-DATA')!;
    input.value = '/srv/data';
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(fixture.componentInstance.kinds).toEqual([{ key: 'PORT', kind: 'text' }]);
    expect(fixture.componentInstance.changes).toEqual([{ key: 'DATA', value: '/srv/data' }]);
  });
});
