import { NgTemplateOutlet } from '@angular/common';
import { Component, DOCUMENT, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { type AppRemovalItem, catalogIconPath, FILES_ERROR_CODES } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideRefreshCw, lucideTrash2 } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTabsImports } from '@ui/tabs';
import { Formatter } from '../../../shared/format/formatter';
import { SaveBar } from '../../../shared/save-bar/save-bar';
import { openUrl } from '../app-actions';
import { AppHeader } from '../app-header/app-header';
import { AppOverview } from '../app-overview/app-overview';
import { AppSettings } from '../app-settings/app-settings';
import type { AppTab, FieldChange } from '../apps.model';
import { DeleteDialog } from '../delete-dialog/delete-dialog';
import { RemoveDialog } from '../remove-dialog/remove-dialog';
import { TaskOutput } from '../task-output/task-output';
import { UpdateDialog } from '../update-dialog/update-dialog';
import { AppPageStore } from './store/app-page-store';

/**
 * One app: its band, a running task, then Overview (stats, containers, its files without
 * containers, backup, update) | Settings.
 */
@Component({
  selector: 'ilex-app-page',
  imports: [
    AppHeader,
    AppOverview,
    AppSettings,
    DeleteDialog,
    HlmButton,
    HlmSkeleton,
    HlmTabsImports,
    NgIcon,
    NgTemplateOutlet,
    RemoveDialog,
    RouterLink,
    SaveBar,
    TaskOutput,
    TranslatePipe,
    UpdateDialog,
  ],
  providers: [AppPageStore, provideIcons({ lucideArrowLeft, lucideRefreshCw, lucideTrash2 })],
  templateUrl: './app-page.html',
})
export class AppPage {
  protected readonly appPageStore = inject(AppPageStore);
  protected readonly formatter = inject(Formatter);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(DOCUMENT).location;
  private readonly removeDialog = viewChild.required(RemoveDialog);
  private readonly deleteDialog = viewChild.required(DeleteDialog);
  private readonly updateDialog = viewChild.required(UpdateDialog);
  protected readonly codes = FILES_ERROR_CODES;
  private readonly params = toSignal(this.route.paramMap, { requireSync: true });
  private readonly query = toSignal(this.route.queryParamMap, { requireSync: true });
  // Separate, so switching tabs (a query change) doesn't read the app again.
  private readonly name = computed(() => this.params().get('name') ?? '');
  private readonly folder = computed(() => this.query().get('folder'));
  private readonly tab = computed<AppTab>(() =>
    this.query().get('tab') === 'settings' ? 'settings' : 'overview',
  );

  protected readonly openUrl = computed(() =>
    openUrl(this.appPageStore.summary(), this.location.hostname),
  );
  protected readonly iconUrl = computed(() => {
    const template = this.appPageStore.template();
    return template ? catalogIconPath(template.id) : null;
  });

  constructor() {
    effect(() => {
      const [name, folder] = [this.name(), this.folder()];
      untracked(() => this.appPageStore.open(name, folder));
    });
    effect(() => {
      this.appPageStore.setTab(this.tab());
    });
    effect(() => {
      if (this.appPageStore.removed()) void this.router.navigate(['/apps']);
    });
  }

  protected chooseTab(tab: string): void {
    if (tab === this.tab()) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === 'settings' ? 'settings' : null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected change(change: FieldChange): void {
    this.appPageStore.setValue(change.key, change.value);
  }

  protected askRemove(): void {
    this.removeDialog().open();
  }

  protected askDelete(): void {
    this.deleteDialog().open();
    void this.appPageStore.openDeletion();
  }

  protected deleteFiles(items: AppRemovalItem[]): void {
    void this.appPageStore.deleteFiles(items);
  }

  protected askUpdate(): void {
    this.updateDialog().open();
  }
}
