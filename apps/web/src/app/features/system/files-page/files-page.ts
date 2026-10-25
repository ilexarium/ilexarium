import {
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { FileEntry, LinuxSignInRequest } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUp,
  lucideCircleCheck,
  lucideCircleX,
  lucideFolderPlus,
  lucideLogOut,
  lucideRefreshCw,
  lucideUpload,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmProgressImports } from '@ui/progress';
import { HlmSkeleton } from '@ui/skeleton';
import { FileDeleteDialog } from '../file-delete-dialog/file-delete-dialog';
import { FileList } from '../file-list/file-list';
import { FileNameDialog } from '../file-name-dialog/file-name-dialog';
import { SignInDialog } from '../sign-in-dialog/sign-in-dialog';
import type { FileAction } from '../files.model';
import { joinPath } from '../files-paths';
import { FilesPageStore } from './files-page-store';
import { EmptyState } from '../../../shared/empty-state/empty-state';

/**
 * The Files page (docs/plans/files_and_terminal.md): sign in as a Linux user, then browse,
 * download, upload (button or drop), make folders, rename or move, delete — exactly what that
 * account may. The data and actions are the page store's; the page asks before deleting and
 * before replacing a file.
 */
@Component({
  selector: 'laris-files-page',
  imports: [
    EmptyState,
    FileDeleteDialog,
    FileList,
    FileNameDialog,
    HlmAlertDialogImports,
    HlmButton,
    HlmProgressImports,
    HlmSkeleton,
    NgIcon,
    SignInDialog,
    TranslatePipe,
  ],
  providers: [
    FilesPageStore,
    provideIcons({
      lucideArrowUp,
      lucideCircleCheck,
      lucideCircleX,
      lucideFolderPlus,
      lucideLogOut,
      lucideRefreshCw,
      lucideUpload,
    }),
  ],
  templateUrl: './files-page.html',
})
export class FilesPage {
  protected readonly filesPageStore = inject(FilesPageStore);
  private readonly nameDialog = viewChild.required(FileNameDialog);
  private readonly deleteDialog = viewChild.required(FileDeleteDialog);
  private readonly replaceDialog = viewChild.required<HlmAlertDialog>('replaceDialog');
  private readonly signInButton = viewChild<ElementRef<HTMLButtonElement>>('signInButton');

  /** Files dragged over the page. */
  protected readonly dragging = signal(false);
  /** Uploads whose name is taken there: one question for all of them. */
  protected readonly taken = signal<File[]>([]);
  /** Opens on its own once, on arrival without a Linux session; then only from the button. */
  protected readonly signInOpen = signal(false);
  protected readonly signIn = (request: LinuxSignInRequest) => this.filesPageStore.signIn(request);
  protected readonly urlFor = (entry: FileEntry) => this.filesPageStore.downloadUrl(entry);
  /** The names in the folder shown that are being renamed or deleted. */
  protected readonly busy = computed(() => {
    const folder = this.filesPageStore.list()?.path;
    if (!folder) return [];
    return this.filesPageStore
      .list()!
      .entries.map((e) => e.name)
      .filter((name) => this.filesPageStore.pending().includes(joinPath(folder, name)));
  });

  constructor() {
    let arrived = false;
    effect(() => {
      if (arrived || !this.filesPageStore.checked()) return;
      arrived = true;
      if (!this.filesPageStore.session()) untracked(() => this.signInOpen.set(true));
    });
  }

  protected signInClosed(): void {
    this.signInOpen.set(false);
    this.signInButton()?.nativeElement.focus();
  }

  protected openEntry(entry: FileEntry): void {
    const folder = this.filesPageStore.list()?.path;
    if (folder) this.filesPageStore.open(joinPath(folder, entry.name));
  }

  protected act(action: FileAction): void {
    if (action.kind === 'rename') this.nameDialog().open({ kind: 'rename', entry: action.entry });
    else this.deleteDialog().open(action.entry, this.filesPageStore.summary(action.entry));
  }

  protected newFolder(): void {
    this.nameDialog().open({ kind: 'newFolder' });
  }

  protected chosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.upload([...(input.files ?? [])]);
    input.value = '';
  }

  protected dragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragging.set(true);
  }

  protected dragLeave(event: DragEvent): void {
    const to = event.relatedTarget as Node | null;
    if (!to || !(event.currentTarget as Node).contains(to)) this.dragging.set(false);
  }

  protected dropped(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    // Plain files only: a dropped folder has no contents to read here.
    const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.size > 0 || f.type);
    if (files.length) void this.upload(files);
  }

  /** The question's confirm: uploads the taken files again, replacing what's there. */
  protected async replace(): Promise<void> {
    this.replaceDialog().close();
    await this.filesPageStore.upload(this.taken(), true);
  }

  private async upload(files: File[]): Promise<void> {
    const taken = await this.filesPageStore.upload(files);
    if (taken.length) {
      this.taken.set(taken);
      this.replaceDialog().open();
    }
  }
}
