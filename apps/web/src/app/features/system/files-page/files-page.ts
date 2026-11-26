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
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { FileEntry, LinuxSignInRequest } from '@ilex/shared';
import { map } from 'rxjs';
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
import { FilePreviewDialog } from '../file-preview-dialog/file-preview-dialog';
import { SignInDialog } from '../../../shared/sign-in-dialog/sign-in-dialog';
import type { FileAction } from '../files.model';
import { joinPath } from '../../../core/files/files-paths';
import { FilesPageStore } from './files-page-store';
import { EmptyState } from '../../../shared/empty-state/empty-state';

/**
 * The Files page: sign in as a Linux user, then browse,
 * preview (images and text), download, upload (button or drop), make folders, rename or move, delete — exactly what that
 * account may, or as root through its unlocked sudo (the lock button; locked on every visit). The
 * open folder is the address's (`?path=`): opening one navigates, so back and forward (a phone's
 * back gesture) move through the folders, and the store loads what the address names. The data
 * and actions are the page store's; the page asks before deleting. The uploads' progress and the
 * question before replacing a file are the uploads panel's (every page).
 */
@Component({
  selector: 'ilex-files-page',
  imports: [
    EmptyState,
    FileDeleteDialog,
    FileList,
    FileNameDialog,
    FilePreviewDialog,
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
  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly addressPath = toSignal(
    this.activatedRoute.queryParamMap.pipe(map((params) => params.get('path'))),
    { initialValue: null },
  );
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
    // The address decides which folder is open: without one (or not a path), the home folder in
    // its place; another account than the last one (also after a sign-out), its home folder.
    // Opened when it isn't the folder shown, so a folder that failed opens again when asked.
    let account: string | null = null;
    effect(() => {
      const session = this.filesPageStore.session();
      const path = this.addressPath();
      if (!session) return;
      const who = `${session.username}:${session.home}`;
      const switched = account !== null && account !== who;
      account = who;
      const target = !path?.startsWith('/') || switched ? session.home : path;
      untracked(() => {
        if (target !== path) this.go(target, { replace: true });
        else if (target !== this.filesPageStore.list()?.path) this.filesPageStore.open(target);
      });
    });
    // A folder that didn't open: the address names the one still shown again (home when none),
    // so it matches the page and back doesn't return to the refused one.
    effect(() => {
      if (this.filesPageStore.refused() === null) return;
      untracked(() => {
        const shown = this.filesPageStore.list()?.path ?? this.filesPageStore.session()?.home;
        this.filesPageStore.refusalHandled();
        if (shown) this.go(shown, { replace: true });
      });
    });

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
    if (folder) this.go(joinPath(folder, entry.name));
  }

  protected go(path: string, { replace = false } = {}): void {
    void this.router.navigate([], {
      relativeTo: this.activatedRoute,
      queryParams: { path },
      replaceUrl: replace,
    });
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
