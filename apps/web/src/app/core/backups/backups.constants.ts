/**
 * Set while Ilexarium is being restored from the backup disk (when it started): the sign-in page
 * it ends on says it was restored. Per browser, like a preference; gone once someone signs in.
 */
export const RECOVERY_STORAGE_KEY = 'ilex.recovered';

/** An older mark is a recovery left behind (the tab closed meanwhile): not mentioned any more. */
export const RECOVERY_NOTICE_MS = 30 * 60_000;
