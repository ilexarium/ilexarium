import { Controller, Get, Param, Res } from '@nestjs/common';
import type { TemplateDetails, TemplateSummary } from '@laris/shared';
import type { Response } from 'express';
import { CatalogIdParamsDto } from './catalog.dto.js';
import { CatalogService } from './catalog.service.js';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  list(): TemplateSummary[] {
    return this.catalogService.list();
  }

  @Get(':id')
  details(@Param() { id }: CatalogIdParamsDto): TemplateDetails {
    return this.catalogService.details(id);
  }

  /** Only ever used in <img>; the headers make sure nothing in it could run anyway. */
  @Get(':id/icon')
  icon(@Param() { id }: CatalogIdParamsDto, @Res() res: Response): void {
    res
      .set({
        'Content-Type': 'image/svg+xml',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
      })
      .send(this.catalogService.require(id).icon);
  }
}
