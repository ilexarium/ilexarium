import type { ProfilePictureType, PublicUser } from '@laris/shared';

/** Who changes their profile, for the audit log. */
export interface ProfileActor {
  user: PublicUser;
  ip: string;
}

/** What a picture's bytes say it is (`inspectPicture`). */
export interface PictureInfo {
  type: ProfilePictureType;
  width: number;
  height: number;
}
