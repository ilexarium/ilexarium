import { FILES_ERROR_CODES } from '@ilex/shared';

/** A folder that won't open however often it's tried: the page goes home instead. */
export const UNOPENABLE: readonly string[] = [
  FILES_ERROR_CODES.notFound,
  FILES_ERROR_CODES.permissionDenied,
  FILES_ERROR_CODES.wrongType,
];
