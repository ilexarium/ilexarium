import { Component, computed, inject, input, output } from '@angular/core';
import type { Disk, DiskPartition } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArchive, lucideHardDrive, lucideLock, lucideUsb } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@ui/badge';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import type { MountTarget, UnmountTarget } from '../disks.model';

/**
 * One disk and its partitions: each one's format, size and state, where it's mounted, whether
 * the backups are kept there — and "Mount" or "Unmount". The system's disk is shown, never
 * changed. UI only: the buttons report through `mount` and `unmount`.
 */
@Component({
  selector: 'laris-disk-card',
  imports: [HlmBadge, HlmButton, HlmCardImports, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideArchive, lucideHardDrive, lucideLock, lucideUsb })],
  templateUrl: './disk-card.html',
})
export class DiskCard {
  readonly disk = input.required<Disk>();
  /** Names being unmounted. */
  readonly pending = input<string[]>([]);

  readonly mount = output<MountTarget>();
  readonly unmount = output<UnmountTarget>();

  protected readonly format = inject(Formatter);
  private readonly translator = inject(Translator);

  /** The disk's name on the page: its model, or "Disk sdb". */
  protected readonly name = computed(
    () => this.disk().model ?? this.translator.t('disks.unnamed', { device: this.disk().device }),
  );

  protected label(partition: DiskPartition): string {
    return partition.label ?? this.translator.t('disks.noLabel');
  }

  protected askMount(partition: DiskPartition): void {
    this.mount.emit({ partition, diskName: this.name() });
  }

  protected askUnmount(partition: DiskPartition): void {
    if (!partition.managedName || !partition.mountPoint) return;
    this.unmount.emit({
      name: partition.managedName,
      mountPoint: partition.mountPoint,
      connected: true,
    });
  }
}
