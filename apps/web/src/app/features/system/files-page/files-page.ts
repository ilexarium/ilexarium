import {
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { FileEntry, LinuxSignInRequest } from '@ilex/shared';
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
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmProgressImports } from '@ui/progress';
import { HlmSkeleton } from '@ui/skeleton';
import { FileDeleteDialog } from '../file-delete-dialog/file-delete-dialog';
import { FileList } from '../file-list/file-list';
import { FileNameDialog } from '../file-name-dialog/file-name-dialog';
import { SignInDialog } from '../../../shared/sign-in-dialog/sign-in-dialog';
import type { FileAction, UploadClash } from '../files.model';
import { joinPath } from '../files-paths';
import { FilesPageStore } from './files-page-store';
import { EmptyState } from '../../../shared/empty-state/empty-state';

/**
 * The Files page: sign in as a Linux user, then browse,
 * download, upload (button or drop), make folders, rename or move, delete — exactly what that
 * account may. The data and actions are the page store's; the page asks before deleting and
 * before replacing a file.
 */
@Component({
  selector: 'ilex-files-page',
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
  private readonly signInButton = viewChild<ElementRef<HTMLButtonElement>>('signInButton');

  /** Files dragged over the page. */
  protected readonly dragging = signal(false);
  /** Opens on its own once, on arrival without a Linux session; then only from the button. */
  protected readonly signInOpen = signal(false);
  /** The clashes asked about, kept while the question closes (so it doesn't go blank). */
  protected readonly shownClashes = linkedSignal<UploadClash[], UploadClash[]>({
    source: this.filesPageStore.clashes,
    computation: (clashes, previous) => (clashes.length ? clashes : (previous?.value ?? [])),
  });
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

  /** Closed without Replace (Cancel, Escape): kept — as soon as it starts closing. */
  protected clashQuestionChanged(state: 'open' | 'closed'): void {
    if (state === 'closed' && this.filesPageStore.clashes().length)
      this.filesPageStore.answerClashes(false);
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
    this.filesPageStore.upload({ files: [...(input.files ?? [])], replace: false });
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
    if (files.length) this.filesPageStore.upload({ files, replace: false });
  }
}
