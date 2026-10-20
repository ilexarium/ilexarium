import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { PROFILE_AVATAR_PATH, type ProfileUpdate, type UserResponse } from '@homelab/shared';
import { firstValueFrom } from 'rxjs';

/** Changes to the signed-in person's profile (`/api/profile`); reading it is `AuthApi.me()`. */
@Service()
export class ProfileApi {
  private readonly http = inject(HttpClient);

  update(body: ProfileUpdate): Promise<UserResponse> {
    return firstValueFrom(this.http.patch<UserResponse>('/api/profile', body));
  }

  /** The picture as the browser drew it (600×600 WebP or JPEG); the server checks its bytes. */
  setAvatar(picture: Blob): Promise<UserResponse> {
    return firstValueFrom(this.http.put<UserResponse>(PROFILE_AVATAR_PATH, picture));
  }

  removeAvatar(): Promise<UserResponse> {
    return firstValueFrom(this.http.delete<UserResponse>(PROFILE_AVATAR_PATH));
  }
}
