import { provideTestTranslations } from './app/core/i18n/testing';

// Browser features jsdom lacks, which spartan's select uses when its list opens (it watches the
// trigger's size and scrolls the chosen option into view). Nothing to do in a test.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
Element.prototype.scrollIntoView ??= function (): void {};

/** Providers for every unit test (angular.json: test → providersFile). */
export default [provideTestTranslations()];
