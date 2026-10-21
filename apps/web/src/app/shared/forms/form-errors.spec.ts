import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormErrors } from './form-errors';

@Component({
  imports: [FormErrors],
  template: `<app-form-errors [form]="form" />`,
})
class FormHost {
  readonly errors = signal([
    { kind: 'server', message: 'errors.server', params: { status: 502 } },
    { kind: 'x', message: 'errors.tooManyAttempts' },
  ]);
  readonly form = () => ({ errors: this.errors });
}

describe('FormErrors', () => {
  it('shows each form error as an alert of its own, worded', async () => {
    const fixture = TestBed.createComponent(FormHost);
    await fixture.whenStable();
    const alerts = fixture.nativeElement.querySelectorAll('[role=alert]');
    expect([...alerts].map((alert) => alert.textContent.trim())).toEqual([
      'Something went wrong (502).',
      'Too many attempts. Try again later.',
    ]);
    fixture.componentInstance.errors.set([]);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('[role=alert]')).toHaveLength(0);
  });

  it('takes no room of its own: the alerts are the form’s items', async () => {
    const fixture = TestBed.createComponent(FormHost);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-form-errors').classList).toContain('contents');
  });
});
