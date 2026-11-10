import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, FormField, minLength, pattern } from '@angular/forms/signals';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { FieldErrors } from './field-errors';

function passwordForm() {
  return form(signal({ password: 'abc' }), (path) => {
    minLength(path.password, 12, { message: 'validation.passwordTooShort' });
    pattern(path.password, /\d/, { message: 'validation.usernameInvalid' });
  });
}

@Component({
  imports: [FieldErrors, FormField, HlmFieldImports, HlmInput],
  template: `
    <div hlmField>
      <input hlmInput id="password" [formField]="form.password" />
      <ilex-field-errors [field]="form.password" />
    </div>
  `,
})
class FieldHost {
  readonly form = passwordForm();
}

@Component({
  imports: [FieldErrors, FormField],
  template: `
    <input [formField]="form.password" />
    <ilex-field-errors [field]="form.password" />
  `,
})
class NoFieldHost {
  readonly form = passwordForm();
}

async function render<T extends { form: ReturnType<typeof passwordForm> }>(host: new () => T) {
  const fixture = TestBed.createComponent(host);
  fixture.componentInstance.form.password().markAsTouched();
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;
  return { element, errors: [...element.querySelectorAll('hlm-field-error')] };
}

describe('FieldErrors', () => {
  it('shows each error on its own, named in the input’s aria-describedby', async () => {
    const { element, errors } = await render(FieldHost);
    expect(errors.map((error) => error.textContent?.trim())).toEqual([
      'At least 12 characters',
      'Only lowercase letters, digits, ".", "_" and "-"',
    ]);
    expect(element.querySelector('input')!.getAttribute('aria-describedby')).toBe(
      errors.map((error) => error.id).join(' '),
    );
  });

  it('takes no room of its own: the errors are the field’s items', async () => {
    const { element } = await render(FieldHost);
    expect(element.querySelector('ilex-field-errors')!.classList).toContain('contents');
  });

  it('works outside an hlmField too', async () => {
    const { errors } = await render(NoFieldHost);
    expect(errors).toHaveLength(2);
  });
});
