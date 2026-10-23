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

export const InstallPageStore = signalStore(
  withState<InstallPageState>({ details: null, problem: null }),
  withComputed((store, backupsStore = inject(BackupsStore)) => ({
    /** "Include in backups" is offered: a backup plan exists and the recipe has a backup. */
    canIncludeInBackups: computed(
      () => backupsStore.configured() && !!store.details()?.meta.backup,
    ),
  })),
  withMethods((store, servicesApi = inject(ServicesApi)) => ({
    async load(id: string): Promise<void> {
      patchState(store, { details: null, problem: null });
      try {
        patchState(store, { details: await servicesApi.details(id) });
      } catch (error) {
        const notFound = error instanceof HttpErrorResponse && error.status === 404;
        patchState(store, { problem: notFound ? 'notFound' : 'failed' });
      }
    },

    /** Starts the install; rejects with the server's error (the form puts it on its fields). */
    deploy(values: FieldValues, includeInBackups: boolean): Promise<DeployResponse> {
      const details = store.details();
      if (!details) return Promise.reject(new Error('Nothing loaded'));
      return servicesApi.deploy({
        catalogId: details.meta.id,
        values,
        ...(store.canIncludeInBackups() ? { includeInBackups } : {}),
      });
    },
  })),
);
