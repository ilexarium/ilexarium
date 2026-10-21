import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormErrors } from './form-errors';

@Component({
  imports: [FormErrors],
  template: `<app-form-errors [form]="form" />`,
})
class FormHost {
  readonly errors = signal([{ kind: 'server', message: 'errors.server', params: { status: 502 } }]);
  readonly form = () => ({ errors: this.errors });
}

describe('FormErrors', () => {
  it('shows each form error as an alert, worded', async () => {
    const fixture = TestBed.createComponent(FormHost);
    await fixture.whenStable();
    const alerts = fixture.nativeElement.querySelectorAll('[role=alert]');
    expect([...alerts].map((alert) => alert.textContent.trim())).toEqual([
      'Something went wrong (502).',
    ]);
    fixture.componentInstance.errors.set([]);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('[role=alert]')).toHaveLength(0);
  });
});
