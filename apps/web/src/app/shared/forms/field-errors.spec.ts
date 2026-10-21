import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form, FormField, required } from '@angular/forms/signals';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { FieldErrors } from './field-errors';

@Component({
  imports: [FieldErrors, FormField, HlmFieldImports, HlmInput],
  template: `
    <div hlmField>
      <input hlmInput id="password" [formField]="form.password" />
      <app-field-errors [field]="form.password" />
    </div>
  `,
})
class FieldHost {
  readonly form = form(signal({ password: '' }), (path) =>
    required(path.password, { message: 'validation.passwordRequired' }),
  );
}

describe('FieldErrors', () => {
  it('shows the field’s errors and names them in the input’s aria-describedby', async () => {
    const fixture = TestBed.createComponent(FieldHost);
    fixture.componentInstance.form.password().markAsTouched();
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const error = element.querySelector('hlm-field-error')!;
    expect(error.textContent?.trim()).toBe('Enter your password');
    expect(element.querySelector('input')!.getAttribute('aria-describedby')).toBe(error.id);
  });
});
