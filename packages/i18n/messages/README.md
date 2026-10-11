# Translations

One file per language, the same keys in each (`en.json` is the reference). Keys are nested by
area; placeholders are `{{ name }}`. Plural keys have one entry per plural form of the language,
suffixed with the form `Intl.PluralRules` names (`_one`, `_other`; Arabic also `_zero`, `_two`,
`_few`, `_many`). The tests in `src/messages.spec.ts` keep the files consistent.

Machine-written until reviewed by a native speaker: `de.json`, `ar.json`.
