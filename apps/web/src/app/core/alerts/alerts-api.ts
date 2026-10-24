import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type {
  AlertChannel,
  AlertChannelsResponse,
  AlertsStatus,
  AlertTestResponse,
  EmailChannelUpdate,
  NtfyChannelUpdate,
} from '@laris/shared';
import type { Observable } from 'rxjs';

/** The server's alert endpoints. Open alerts arrive through the `alerts` topic. */
@Service()
export class AlertsApi {
  private readonly http = inject(HttpClient);

  status(): Observable<AlertsStatus> {
    return this.http.get<AlertsStatus>('/api/alerts');
  }

  acknowledge(id: string): Observable<void> {
    return this.http.post<void>(`/api/alerts/${encodeURIComponent(id)}/acknowledge`, {});
  }

  channels(): Observable<AlertChannelsResponse> {
    return this.http.get<AlertChannelsResponse>('/api/alerts/channels');
  }

  updateEmail(update: EmailChannelUpdate): Observable<void> {
    return this.http.put<void>('/api/alerts/channels/email', update);
  }

  updateNtfy(update: NtfyChannelUpdate): Observable<void> {
    return this.http.put<void>('/api/alerts/channels/ntfy', update);
  }

  /** Sends a test message; says whether it got through. */
  test(channel: AlertChannel): Observable<AlertTestResponse> {
    return this.http.post<AlertTestResponse>(`/api/alerts/channels/${channel}/test`, {});
  }
}
