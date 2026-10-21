import { HttpErrorResponse } from '@angular/common/http';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import type { CatalogEntryDetails, DeployResponse, FieldValues } from '@laris/shared';
import { BackupsStore } from '../../../core/backups/backups-store';
import { ServicesApi } from '../../../core/services/services-api';

interface InstallPageState {
  /** Null while loading or when it couldn't be loaded. */
  details: CatalogEntryDetails | null;
  problem: 'notFound' | 'failed' | null;
}

/** The install page's data, provided by the page and gone with it: one entry, and installing it. */
export const InstallPageStore = signalStore(
  withState<InstallPageState>({ details: null, problem: null }),
  withComputed((store, backups = inject(BackupsStore)) => ({
    /** "Include in backups" is offered: a backup plan exists and the recipe has a backup. */
    canIncludeInBackups: computed(() => backups.configured() && !!store.details()?.meta.backup),
  })),
  withMethods((store, api = inject(ServicesApi)) => ({
    async load(id: string): Promise<void> {
      patchState(store, { details: null, problem: null });
      try {
        patchState(store, { details: await api.details(id) });
      } catch (error) {
        const notFound = error instanceof HttpErrorResponse && error.status === 404;
        patchState(store, { problem: notFound ? 'notFound' : 'failed' });
      }
    },

    /** Starts the install; rejects with the server's error (the form puts it on its fields). */
    deploy(values: FieldValues, includeInBackups: boolean): Promise<DeployResponse> {
      const details = store.details();
      if (!details) return Promise.reject(new Error('Nothing loaded'));
      return api.deploy({
        catalogId: details.meta.id,
        values,
        ...(store.canIncludeInBackups() ? { includeInBackups } : {}),
      });
    },
  })),
);
