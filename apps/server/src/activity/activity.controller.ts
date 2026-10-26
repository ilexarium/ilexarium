import { Controller, Get } from '@nestjs/common';
import type { ActivityResponse } from '@laris/shared';
import { ActivityService } from './activity.service.js';

@Controller('activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get()
  async recent(): Promise<ActivityResponse> {
    return { items: await this.activityService.recent() };
  }
}
