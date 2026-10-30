import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppTask } from '@laris/shared';
import { testTask } from '../../../core/apps/testing';
import { TaskOutput } from './task-output';

@Component({
  imports: [TaskOutput],
  template: `<laris-task-output [task]="task()" />`,
})
class Host {
  readonly task = signal<AppTask>(testTask());
}

describe('TaskOutput', () => {
  it('shows the end of the output as it is answered — each answer all of it', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const log = () => (fixture.nativeElement as HTMLElement).querySelector('pre')!.textContent;
    expect(log()).toContain('Waiting');
    fixture.componentInstance.task.set(testTask({ output: ['pulling', 'pulled'] }));
    await fixture.whenStable();
    expect(log()).toBe('pulling\npulled');
    fixture.componentInstance.task.set(
      testTask({ state: 'succeeded', output: ['pulled', 'started'] }),
    );
    await fixture.whenStable();
    expect(log()).toBe('pulled\nstarted');
  });
});
