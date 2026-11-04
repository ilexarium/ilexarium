/**
 * Asking for disk usage: Docker works out what images share, and an older one (without `type`)
 * walks every volume too.
 */
export const DISK_USAGE_TIMEOUT_MS = 30_000;
/** Docker walks every volume to count its size: on a big disk that takes a while. */
export const VOLUME_SIZES_TIMEOUT_MS = 60_000;
/** Docker's own label on a volume it made without a name. */
export const ANONYMOUS_VOLUME_LABEL = 'com.docker.volume.anonymous';
