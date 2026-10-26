import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ActivityController } from './activity.controller.js';
import { ActivityService } from './activity.service.js';

@Module({
  imports: [CatalogModule],
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}
