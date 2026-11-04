import { TestBed } from '@angular/core/testing';
import { PAGE_RELOAD } from './page-reload';
import { updatesStatus } from './testing';
import { UpdatesStore } from './updates-store';

describe('UpdatesStore', () => {
  function setup() {
    const reload = vi.fn();
    TestBed.configureTestingModule({ providers: [{ provide: PAGE_RELOAD, useValue: reload }] });
    return { store: TestBed.inject(UpdatesStore), reload };
  }

  it('keeps the status, with a newer release as available', () => {
    const { store, reload } = setup();
    store.update(updatesStatus({ available: { version: '0.2.0', published: '', notes: null } }));
    expect(store.available()?.version).toBe('0.2.0');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads the page when the server comes back as another version (its files are gone)', () => {
    const { store, reload } = setup();
    store.update(updatesStatus({ installed: '0.1.0' }));
    store.update(updatesStatus({ installed: '0.1.0', checkAutomatically: false }));
    expect(reload).not.toHaveBeenCalled();
    store.update(updatesStatus({ installed: '0.2.0' }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
