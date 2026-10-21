import { DOCUMENT, inject, InjectionToken } from '@angular/core';
import { SIGN_OUT_CHANNEL_NAME } from './auth.constants';

/** Tells the app's other tabs that this one signed out. A token so tests can fake it. */
export const SIGN_OUT_CHANNEL = new InjectionToken<BroadcastChannel | null>('SIGN_OUT_CHANNEL', {
  factory: () => {
    const view = inject(DOCUMENT).defaultView;
    return view?.BroadcastChannel ? new view.BroadcastChannel(SIGN_OUT_CHANNEL_NAME) : null;
  },
});
