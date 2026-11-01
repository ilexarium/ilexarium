import { Component, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { HlmLabel } from '@ui/label';
import type { BackupChoice } from '../apps.model';

/** A new app's backup: included or not, stopped or kept running meanwhile, the subfolders skipped. */
@Component({
  selector: 'laris-backup-options',
  imports: [HlmButton, HlmInput, HlmLabel, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideX })],
  host: { class: 'grid gap-3' },
  templateUrl: './backup-options.html',
})
export class BackupOptions {
  readonly value = input.required<BackupChoice>();
  readonly changed = output<Partial<BackupChoice>>();
  protected readonly newSkip = signal('');

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected addSkip(): void {
    const skip = this.newSkip()
      .trim()
      .replace(/^\.?\/+/, '');
    if (!skip) return;
    const { skip: list } = this.value();
    if (!list.includes(skip)) this.changed.emit({ skip: [...list, skip] });
    this.newSkip.set('');
  }

  protected removeSkip(skip: string): void {
    this.changed.emit({ skip: this.value().skip.filter((s) => s !== skip) });
  }
}
