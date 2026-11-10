import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type {
  AuthStatusResponse,
  ChangePasswordRequest,
  LoginRequest,
  MeResponse,
  SetupRequest,
  UserResponse,
} from '@ilex/shared';
import type { Observable } from 'rxjs';

@Service()
export class AuthApi {
  private readonly http = inject(HttpClient);

  status(): Observable<AuthStatusResponse> {
    return this.http.get<AuthStatusResponse>('/api/auth/status');
  }

  me(): Observable<MeResponse> {
    return this.http.get<MeResponse>('/api/auth/me');
  }

  setup(body: SetupRequest): Observable<UserResponse> {
    return this.http.post<UserResponse>('/api/auth/setup', body);
  }

  login(body: LoginRequest): Observable<UserResponse> {
    return this.http.post<UserResponse>('/api/auth/login', body);
  }

  logout(): Observable<unknown> {
    return this.http.post('/api/auth/logout', null);
  }

  logoutEverywhere(): Observable<unknown> {
    return this.http.post('/api/auth/logout-everywhere', null);
  }

  changePassword(body: ChangePasswordRequest): Observable<unknown> {
    return this.http.post('/api/auth/password', body);
  }
}
