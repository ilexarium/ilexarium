import {
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { FileEntry } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideDownload,
  lucideEllipsis,
  lucideFile,
  lucideFolder,
  lucideFolderOpen,
  lucideLink,
  lucidePencil,
  lucideTrash2,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmTableImports } from '@ui/table';
import { Formatter } from '../../../shared/format/formatter';
import type { FileAction } from '../files.model';

/** Where the table starts (Tailwind's `xl`): below it, a list. */
const WIDE = '(min-width: 1280px)';

interface Row {
  entry: FileEntry;
  /** Opens as a folder (a folder, or a link to one). */
  folder: boolean;
  /** Downloads (a file, or a link to one). */
  file: boolean;
  icon: string;
  size: string;
  modified: string;
  busy: boolean;
}

/**
 * A folder's entries: a table on wide screens, a list below (only the one that fits is
 * rendered). Folders open, files download (a plain link: the browser saves the attachment);
 * rename and delete go out through `action` (the page asks). Presentational.
 */
@Component({
  selector: 'app-file-list',
  imports: [
    HlmButton,
    HlmDropdownMenuImports,
    HlmTableImports,
    NgIcon,
    NgTemplateOutlet,
    TranslatePipe,
  ],
  providers: [
    provideIcons({
      lucideDownload,
      lucideEllipsis,
      lucideFile,
      lucideFolder,
      lucideFolderOpen,
      lucideLink,
      lucidePencil,
      lucideTrash2,
    }),
  ],
  templateUrl: './file-list.html',
})
export class FileList {
  readonly entries = input.required<FileEntry[]>();
  /** The download address of an entry. */
  readonly urlFor = input.required<(entry: FileEntry) => string>();
  /** Names being renamed or deleted. */
  readonly busy = input<string[]>([]);
  readonly open = output<FileEntry>();
  readonly action = output<FileAction>();

  private readonly format = inject(Formatter);
  protected readonly wide = signal(true);

  protected readonly rows = computed<Row[]>(() => {
    const busy = new Set(this.busy());
    return this.entries().map((entry) => {
      const folder = entry.type === 'folder' || entry.linkTarget === 'folder';
      const file = entry.type === 'file' || entry.linkTarget === 'file';
      return {
        entry,
        folder,
        file,
        icon: entry.type === 'link' ? 'lucideLink' : folder ? 'lucideFolder' : 'lucideFile',
        size: file ? this.format.bytes(entry.size) : '—',
        modified: this.format.dateTime(entry.modifiedAt),
        busy: busy.has(entry.name),
      };
    });
  });

  constructor() {
    const media = inject(DOCUMENT).defaultView?.matchMedia?.(WIDE);
    if (media) {
      this.wide.set(media.matches);
      const changed = (event: MediaQueryListEvent) => this.wide.set(event.matches);
      media.addEventListener('change', changed);
      inject(DestroyRef).onDestroy(() => media.removeEventListener('change', changed));
    }
  }
}
