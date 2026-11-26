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
import type { FileEntry, LinuxSignInRequest } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUp,
  lucideFolderPlus,
  lucideLock,
  lucideLockOpen,
  lucideLogOut,
  lucideRefreshCw,
  lucideUpload,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmSkeleton } from '@ui/skeleton';
import { FileDeleteDialog } from '../file-delete-dialog/file-delete-dialog';
import { FileList } from '../file-list/file-list';
import { FileNameDialog } from '../file-name-dialog/file-name-dialog';
import { SignInDialog } from '../../../shared/sign-in-dialog/sign-in-dialog';
import type { FileAction } from '../files.model';
import { joinPath } from '../../../core/files/files-paths';
import { FilesPageStore } from './files-page-store';
import { EmptyState } from '../../../shared/empty-state/empty-state';

/**
 * The Files page: sign in as a Linux user, then browse,
 * download, upload (button or drop), make folders, rename or move, delete — exactly what that
 * account may, or as root through its unlocked sudo (the lock button; locked on every visit). The data and actions are the page store's; the page asks before deleting. The
 * uploads' progress and the question before replacing a file are the uploads panel's (every page).
 */
@Component({
  selector: 'ilex-files-page',
  imports: [
    EmptyState,
    FileDeleteDialog,
    FileList,
    FileNameDialog,
    HlmButton,
    HlmSkeleton,
    NgIcon,
    SignInDialog,
    TranslatePipe,
  ],
  providers: [
    FilesPageStore,
    provideIcons({
      lucideArrowUp,
      lucideFolderPlus,
      lucideLock,
      lucideLockOpen,
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
  private readonly signInButton = viewChild<ElementRef<HTMLButtonElement>>('signInButton');

  /** Files dragged over the page. */
  protected readonly dragging = signal(false);
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
    else this.filesPageStore.askDelete(action.entry);
  }

  protected newFolder(): void {
    this.nameDialog().open({ kind: 'newFolder' });
  }

  protected chosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.filesPageStore.upload([...(input.files ?? [])]);
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
    if (files.length) this.filesPageStore.upload(files);
  }
}
