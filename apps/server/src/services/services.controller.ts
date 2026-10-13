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
  ServiceJob,
  ServicesList,
} from '@homelab/shared';
import type { Response } from 'express';
import { CatalogIdParamsDto, DeployDto, ServiceIdParamsDto } from './services.dto.js';
import { ServiceManager } from './service-manager.js';

/** Per IP, for installs and removals only (slow and rare); reads aren't limited — pages poll them. */
const CHANGE_LIMIT = { default: { limit: 10, ttl: 60_000 } };

@Controller()
export class ServicesController {
  constructor(private readonly services: ServiceManager) {}

  @Get('catalog')
  catalog(): Promise<CatalogEntrySummary[]> {
    return this.services.listCatalog();
  }

  @Get('catalog/:id')
  details(@Param() { id }: CatalogIdParamsDto): Promise<CatalogEntryDetails> {
    return this.services.catalogDetails(id);
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
      .send(this.services.icon(id));
  }

  @Get('services')
  async list(): Promise<ServicesList> {
    return { services: await this.services.list() };
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
    return this.services.deploy(body, { user, ip });
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
    return this.services.remove(id, { user, ip });
  }

  @Get('services/jobs/:id')
  job(@Param() { id }: ServiceIdParamsDto): Promise<ServiceJob> {
    return this.services.job(id);
  }
}
