import { Controller, Delete, Get, HttpCode, Ip, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { DockerCleanup, DockerPruneResult, PublicUser, VolumeSizes } from '@laris/shared';
import { VolumeParamsDto } from './docker-cleanup.dto.js';
import { CLEANUP_LIMIT } from './docker-cleanup.constants.js';
import { DockerCleanupService } from './docker-cleanup.service.js';

@Controller('docker/cleanup')
export class DockerCleanupController {
  constructor(private readonly dockerCleanupService: DockerCleanupService) {}

  @Get()
  overview(): Promise<DockerCleanup> {
    return this.dockerCleanupService.overview();
  }

  /** Separate: Docker walks every volume to count them. */
  @Get('volume-sizes')
  volumeSizes(): Promise<VolumeSizes> {
    return this.dockerCleanupService.volumeSizes();
  }

  @Post('prune')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(CLEANUP_LIMIT)
  prune(@CurrentUser() user: PublicUser, @Ip() ip: string): Promise<DockerPruneResult> {
    return this.dockerCleanupService.prune({ user, ip });
  }

  @Delete('volumes/:name')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CLEANUP_LIMIT)
  async removeVolume(
    @Param() { name }: VolumeParamsDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    await this.dockerCleanupService.removeVolume(name, { user, ip });
  }
}
