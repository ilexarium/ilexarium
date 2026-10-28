import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller.js';
import { ActivityService } from './activity.service.js';

@Module({
  imports: [],
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}
