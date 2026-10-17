import {
  alertChannelParamsSchema,
  alertIdParamsSchema,
  emailChannelUpdateSchema,
  ntfyChannelUpdateSchema,
} from '@homelab/shared';
import { zodDto } from '../common/zod-dto.js';

export class AlertIdParamsDto extends zodDto(alertIdParamsSchema) {}
export class AlertChannelParamsDto extends zodDto(alertChannelParamsSchema) {}
export class EmailChannelUpdateDto extends zodDto(emailChannelUpdateSchema) {}
export class NtfyChannelUpdateDto extends zodDto(ntfyChannelUpdateSchema) {}
