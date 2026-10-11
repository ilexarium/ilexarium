import type { ComponentFixture } from '@angular/core/testing';

/** Types into the input with this id, as a user would (fires `input`). */
export function typeInto(fixture: ComponentFixture<unknown>, id: string, value: string): void {
  const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`No input #${id}`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

/** Clicks the form's submit button and lets the submission settle. */
export async function submit(fixture: ComponentFixture<unknown>): Promise<void> {
  (fixture.nativeElement as HTMLElement)
    .querySelector<HTMLButtonElement>('button[type=submit]')!
    .click();
  await fixture.whenStable();
}

export const textOf = (fixture: ComponentFixture<unknown>) =>
  (fixture.nativeElement as HTMLElement).textContent ?? '';
