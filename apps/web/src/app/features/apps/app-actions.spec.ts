import { testApp } from '../../core/apps/testing';
import { canStart, canStop, openUrl } from './app-actions';

describe('app actions', () => {
  it('starts what is stopped, stops what runs — both for a partly running app', () => {
    expect([canStart('stopped'), canStop('stopped')]).toEqual([true, false]);
    expect([canStart('partial'), canStop('partial')]).toEqual([true, true]);
    expect([canStart('running'), canStop('running')]).toEqual([false, true]);
    expect([canStart('unhealthy'), canStop('unhealthy')]).toEqual([false, true]);
    // No containers (down, or restored onto a new machine): started from its folder.
    expect([canStart('none'), canStop('none')]).toEqual([true, false]);
  });

  it('opens its port on this machine, only while it has containers', () => {
    expect(openUrl(testApp('music', { webPort: 4533 }), 'box')).toBe('http://box:4533/');
    expect(openUrl(testApp('dns', { webPort: 8080, webPath: '/admin/' }), 'box')).toBe(
      'http://box:8080/admin/',
    );
    expect(openUrl(testApp('music', { webPort: null }), 'box')).toBeNull();
    expect(openUrl(testApp('music', { webPort: 4533, state: 'none' }), 'box')).toBeNull();
    expect(openUrl(null, 'box')).toBeNull();
  });
});
