import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import type {
  AlertChannel,
  AlertChannelsResponse,
  AlertsStatus,
  AlertTestResponse,
  EmailChannelUpdate,
  NtfyChannelUpdate,
} from '@homelab/shared';
import { firstValueFrom } from 'rxjs';

/** The server's alert endpoints. Open alerts arrive through the `alerts` topic. */
@Service()
export class AlertsApi {
  private readonly http = inject(HttpClient);

  status(): Promise<AlertsStatus> {
    return firstValueFrom(this.http.get<AlertsStatus>('/api/alerts'));
  }

  acknowledge(id: string): Promise<void> {
    return firstValueFrom(
      this.http.post<void>(`/api/alerts/${encodeURIComponent(id)}/acknowledge`, {}),
    );
  }

  channels(): Promise<AlertChannelsResponse> {
    return firstValueFrom(this.http.get<AlertChannelsResponse>('/api/alerts/channels'));
  }

  updateEmail(update: EmailChannelUpdate): Promise<void> {
    return firstValueFrom(this.http.put<void>('/api/alerts/channels/email', update));
  }

  updateNtfy(update: NtfyChannelUpdate): Promise<void> {
    return firstValueFrom(this.http.put<void>('/api/alerts/channels/ntfy', update));
  }

  /** Sends a test message; says whether it got through. */
  test(channel: AlertChannel): Promise<AlertTestResponse> {
    return firstValueFrom(
      this.http.post<AlertTestResponse>(`/api/alerts/channels/${channel}/test`, {}),
    );
  }
}
