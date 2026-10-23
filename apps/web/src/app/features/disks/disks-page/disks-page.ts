import { Component, inject, viewChild } from '@angular/core';
import type { DisconnectedDisk } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { DiskCard } from '../disk-card/disk-card';
import type { MountTarget, UnmountTarget } from '../disks.model';
import { MountDialog } from '../mount-dialog/mount-dialog';
import { UnmountDialog } from '../unmount-dialog/unmount-dialog';
import { DisksPageStore } from './disks-page-store';

/**
 * Disks: what's connected (live — a disk plugged in appears at once), each partition's state, and
 * mounting and unmounting them; disks mounted here before that aren't connected now. UI only: the
 * data and actions live in its page store; it opens the dialogs.
 */
@Component({
  selector: 'laris-disks-page',
  imports: [
    DiskCard,
    HlmAlertImports,
    HlmButton,
    HlmCardImports,
    HlmSkeleton,
    MountDialog,
    TranslatePipe,
    UnmountDialog,
  ],
  providers: [DisksPageStore],
  templateUrl: './disks-page.html',
})
export class DisksPage {
  protected readonly disksPageStore = inject(DisksPageStore);
  private readonly mountDialog = viewChild.required(MountDialog);
  private readonly unmountDialog = viewChild.required(UnmountDialog);

  protected openMount(target: MountTarget): void {
    this.mountDialog().open(target, this.disksPageStore.takenNames());
  }

  protected openUnmount(target: UnmountTarget): void {
    this.unmountDialog().open(target);
  }

  protected forget(disk: DisconnectedDisk): void {
    this.unmountDialog().open({ name: disk.name, mountPoint: disk.mountPoint, connected: false });
  }

  protected unmount(target: UnmountTarget): void {
    void this.disksPageStore.unmount(target.name, target.connected);
  }
}
