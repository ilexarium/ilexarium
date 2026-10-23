import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type {
  CatalogEntryDetails,
  CatalogEntrySummary,
  DeployResponse,
  PublicUser,
  RemoveResponse,
  Job,
  ServicesList,
} from '@laris/shared';
import type { Response } from 'express';
import { CatalogIdParamsDto, DeployDto, ServiceIdParamsDto } from './services.dto.js';
import { ServiceManager } from './service-manager.js';
import { CHANGE_LIMIT } from './services.constants.js';

@Controller()
export class ServicesController {
  constructor(private readonly serviceManager: ServiceManager) {}

  @Get('catalog')
  catalog(): Promise<CatalogEntrySummary[]> {
    return this.serviceManager.listCatalog();
  }

  @Get('catalog/:id')
  details(@Param() { id }: CatalogIdParamsDto): Promise<CatalogEntryDetails> {
    return this.serviceManager.catalogDetails(id);
  }

  /** Only ever used in <img>; the headers make sure nothing in it could run anyway. */
  @Get('catalog/:id/icon')
  icon(@Param() { id }: CatalogIdParamsDto, @Res() res: Response): void {
    res
      .set({
        'Content-Type': 'image/svg+xml',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
      })
      .send(this.serviceManager.icon(id));
  }

  @Get('services')
  async list(): Promise<ServicesList> {
    return { services: await this.serviceManager.list() };
  }

  /** 202: the job runs on; progress arrives through the `services` topic. */
  @Post('services')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  deploy(
    @Body() body: DeployDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<DeployResponse> {
    return this.serviceManager.deploy(body, { user, ip });
  }

  /** 202: removes the containers; data and settings stay for a reinstall. */
  @Delete('services/:id')
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  remove(
    @Param() { id }: ServiceIdParamsDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<RemoveResponse> {
    return this.serviceManager.remove(id, { user, ip });
  }

  @Get('services/jobs/:id')
  job(@Param() { id }: ServiceIdParamsDto): Promise<Job> {
    return this.serviceManager.job(id);
  }
}
