import { Component, computed, inject, input, output, viewChild } from '@angular/core';
import type { DockerCleanup, UnusedImage, UnusedVolume } from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Formatter } from '../../../shared/format/formatter';
import { VolumeDialog } from '../volume-dialog/volume-dialog';

/**
 * What Docker keeps that nothing uses: unused images and the build cache, freed together with one
 * confirmed click; volumes no container uses, each deleted on its own. Presentational: data in,
 * the confirmed choice out.
 */
@Component({
  selector: 'ilex-free-space',
  imports: [
    HlmAlertDialogImports,
    HlmButton,
    HlmCardImports,
    HlmSkeleton,
    PluralPipe,
    TranslatePipe,
    VolumeDialog,
  ],
  host: { class: 'block' },
  templateUrl: './free-space.html',
})
export class FreeSpace {
  readonly cleanup = input.required<DockerCleanup>();
  /** Null while Docker counts them. */
  readonly volumeSizes = input<Record<string, number | null> | null>(null);
  readonly volumeSizesFailed = input(false);
  readonly pruning = input(false);
  readonly removing = input<string[]>([]);
  readonly prune = output<void>();
  readonly removeVolume = output<string>();

  protected readonly formatter = inject(Formatter);
  private readonly pruneDialog = viewChild.required(HlmAlertDialog);
  private readonly volumeDialog = viewChild.required(VolumeDialog);

  protected readonly freeable = computed(
    () => this.cleanup().imagesBytes + this.cleanup().buildCacheBytes,
  );
  protected readonly freeableText = computed(() => this.formatter.bytes(this.freeable()));
  protected readonly hasPrunable = computed(
    () => this.cleanup().images.length > 0 || this.cleanup().buildCacheBytes > 0,
  );
  protected readonly empty = computed(
    () => !this.hasPrunable() && this.cleanup().volumes.length === 0,
  );

  /** Pulled by digest: the repository and the digest's start, not 64 hex digits. */
  protected imageName(image: UnusedImage): string {
    const name = image.tags[0];
    if (!name) return image.id;
    return name.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, '@sha256:$1…');
  }

  /** Undefined while counting; null when Docker didn't count it. */
  protected sizeOf(volume: UnusedVolume): number | null | undefined {
    const sizes = this.volumeSizes();
    if (sizes) return sizes[volume.name] ?? null;
    return this.volumeSizesFailed() ? null : undefined;
  }

  protected confirmPrune(): void {
    this.pruneDialog().open();
  }

  protected pruneConfirmed(): void {
    this.pruneDialog().close();
    this.prune.emit();
  }

  protected confirmRemove(volume: UnusedVolume): void {
    this.volumeDialog().open(volume, this.sizeOf(volume) ?? null);
  }
}
