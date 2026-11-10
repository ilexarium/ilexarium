import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppField } from '@ilex/shared';
import { AppFields } from './app-fields';

const field = (key: string, kind: AppField['kind'], value = '', advanced = false): AppField => ({
  key,
  kind,
  value,
  default: null,
  required: false,
  advanced,
});

@Component({
  imports: [AppFields],
  template: `<ilex-app-fields
    [fields]="fields()"
    [values]="values"
    templateId="immich"
    (changed)="changes.push($event)"
  />`,
})
class Host {
  readonly fields = signal([
    field('IMMICH_VERSION', 'version', 'v3'),
    field('WEB_PORT', 'port', '2283'),
    field('UPLOAD_DIR', 'folder', './library'),
    field('DB_PASSWORD', 'generated', 'made'),
    field('TZ', 'text', 'UTC', true),
  ]);
  readonly values = new Map([['WEB_PORT', '9000']]);
  readonly changes: unknown[] = [];
}

async function render() {
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('AppFields', () => {
  it('a template’s fields, its texts; the value from .env first; secrets masked', async () => {
    const { el } = await render();
    expect(el.querySelector('label[for="field-WEB_PORT"]')!.textContent).toContain('Web port');
    expect(el.textContent).toContain("The port Immich's web page");
    expect(el.querySelector('select')).toBeNull();
    expect(el.querySelector<HTMLInputElement>('#field-WEB_PORT')!.value).toBe('9000');
    expect(el.querySelector<HTMLInputElement>('#field-WEB_PORT')!.inputMode).toBe('numeric');
    expect(el.querySelector<HTMLInputElement>('#field-DB_PASSWORD')!.type).toBe('password');
  });

  it('generated and advanced fields folded under “Advanced”', async () => {
    const { el } = await render();
    const advanced = el.querySelector('details')!;
    expect(advanced.querySelector('#field-DB_PASSWORD')).not.toBeNull();
    expect(advanced.querySelector('#field-TZ')).not.toBeNull();
    expect(advanced.querySelector('#field-WEB_PORT')).toBeNull();
  });

  it('reports a value edited', async () => {
    const { el, fixture } = await render();
    const input = el.querySelector<HTMLInputElement>('#field-UPLOAD_DIR')!;
    input.value = '/srv/data';
    input.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(fixture.componentInstance.changes).toEqual([{ key: 'UPLOAD_DIR', value: '/srv/data' }]);
  });
});
