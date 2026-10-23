import { Component, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmSkeleton } from '@ui/skeleton';
import { map } from 'rxjs';
import { InstallForm } from '../install-form/install-form';
import { InstallPageStore } from './install-page-store';

@Component({
  selector: 'laris-install-page',
  imports: [HlmButton, HlmSkeleton, InstallForm, RouterLink, TranslatePipe],
  providers: [InstallPageStore],
  templateUrl: './install-page.html',
})
export class InstallPage {
  protected readonly installPageStore = inject(InstallPageStore);

  /** The route's `:id`. */
  private readonly id = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );

  constructor() {
    effect(() => {
      const id = this.id();
      if (id) void this.installPageStore.load(id);
    });
  }
}
