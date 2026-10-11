import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type {
  AuthStatusResponse,
  ChangePasswordRequest,
  LoginRequest,
  MeResponse,
  SetupRequest,
  UserResponse,
} from '@homelab/shared';
import { firstValueFrom } from 'rxjs';

/** The server's /api/auth endpoints. The session cookie travels automatically (same origin). */
@Service()
export class AuthApi {
  private readonly http = inject(HttpClient);

  status(): Promise<AuthStatusResponse> {
    return firstValueFrom(this.http.get<AuthStatusResponse>('/api/auth/status'));
  }

  me(): Promise<MeResponse> {
    return firstValueFrom(this.http.get<MeResponse>('/api/auth/me'));
  }

  setup(body: SetupRequest): Promise<UserResponse> {
    return firstValueFrom(this.http.post<UserResponse>('/api/auth/setup', body));
  }

  login(body: LoginRequest): Promise<UserResponse> {
    return firstValueFrom(this.http.post<UserResponse>('/api/auth/login', body));
  }

  logout(): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/auth/logout', null));
  }

  changePassword(body: ChangePasswordRequest): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/auth/password', body));
  }
}
