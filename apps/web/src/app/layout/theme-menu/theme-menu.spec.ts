import { TestBed } from '@angular/core/testing';
import { stubLocalStorage } from '../testing';
import { ThemeService } from '../../core/theme/theme';
import { ThemeMenu } from './theme-menu';

describe('ThemeMenu', () => {
  let storage: ReturnType<typeof stubLocalStorage>;

  beforeEach(() => (storage = stubLocalStorage()));
  afterEach(() => {
    storage.restore();
    document.documentElement.classList.remove('dark');
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  async function render() {
    const fixture = TestBed.createComponent(ThemeMenu);
    await fixture.whenStable();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    return { fixture, button };
  }

  it('names the current choice for screen readers', async () => {
    const { fixture, button } = await render();
    expect(button.getAttribute('aria-label')).toBe('Theme: System');
    TestBed.inject(ThemeService).setChoice('dark');
    await fixture.whenStable();
    expect(button.getAttribute('aria-label')).toBe('Theme: Dark');
  });

  it('offers Light, Dark and System as radio items, the current one checked, and switches', async () => {
    const { fixture, button } = await render();
    button.click();
    await fixture.whenStable();
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(items.map((item) => item.textContent!.trim())).toEqual(['Light', 'Dark', 'System']);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ]);

    items[1].click();
    await fixture.whenStable();
    TestBed.tick();
    expect(TestBed.inject(ThemeService).choice()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
