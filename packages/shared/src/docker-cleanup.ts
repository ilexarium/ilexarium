import { z } from 'zod';

/**
 * Freeing space from Docker's unused data (docs/plans/docker_cleanup.md): unused images and the
 * build cache together, volumes no container uses one at a time — each confirmed by the person.
 */

/**
 * A volume's name, as Docker allows it and the socket proxy's path pattern accepts it (it goes
 * into the URL path of the delete).
 */
export const volumeNameSchema = z
  .string()
  .max(255)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);

export const unusedImageSchema = z.object({
  /** Docker's short ID (12 hex digits, without `sha256:`). */
  id: z.string(),
  /** `repository:tag` names; empty for an untagged image. */
  tags: z.array(z.string()),
  bytes: z.number().int().nonnegative(),
  created: z.iso.datetime().nullable(),
});
export type UnusedImage = z.infer<typeof unusedImageSchema>;

export const unusedVolumeSchema = z.object({
  name: volumeNameSchema,
  /** The Compose project it was made for, if any. */
  app: z.string().nullable(),
  /** Made by Docker without a name (a container's anonymous volume). */
  anonymous: z.boolean(),
  created: z.iso.datetime().nullable(),
});
export type UnusedVolume = z.infer<typeof unusedVolumeSchema>;

/** `GET /api/docker/cleanup`: what can be freed. Sizes of volumes come separately (slow). */
export const dockerCleanupSchema = z.object({
  images: z.array(unusedImageSchema),
  /** What removing every unused image frees (shared layers counted once). */
  imagesBytes: z.number().int().nonnegative(),
  /** What emptying the build cache frees; 0 when there's none. */
  buildCacheBytes: z.number().int().nonnegative(),
  /** Volumes no container uses, the platform's own left out. */
  volumes: z.array(unusedVolumeSchema),
});
export type DockerCleanup = z.infer<typeof dockerCleanupSchema>;

/** `GET /api/docker/cleanup/volume-sizes`: bytes by volume name; null where Docker didn't count. */
export const volumeSizesSchema = z.object({
  sizes: z.record(z.string(), z.number().int().nonnegative().nullable()),
});
export type VolumeSizes = z.infer<typeof volumeSizesSchema>;

/** `POST /api/docker/cleanup/prune`: unused images and the build cache removed. */
export const dockerPruneResultSchema = z.object({
  bytesFreed: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
});
export type DockerPruneResult = z.infer<typeof dockerPruneResultSchema>;

export const volumeParamsSchema = z.strictObject({ name: volumeNameSchema });
export type VolumeParams = z.infer<typeof volumeParamsSchema>;

export function volumePath(name: string): string {
  return `/api/docker/cleanup/volumes/${encodeURIComponent(name)}`;
}

export const DOCKER_CLEANUP_ERROR_CODES = {
  /**
   * A backup or restore runs, or an app task started a little while ago: an image just
   * downloaded for it may not have its container yet.
   */
  changesUnderway: 'changes_underway',
  /** One of the platform's own volumes. */
  volumeProtected: 'volume_protected',
  volumeInUse: 'volume_in_use',
  volumeNotFound: 'volume_not_found',
  dockerUnavailable: 'docker_unavailable',
  failed: 'cleanup_failed',
} as const;
export type DockerCleanupErrorCode =
  (typeof DOCKER_CLEANUP_ERROR_CODES)[keyof typeof DOCKER_CLEANUP_ERROR_CODES];
