import { catalogIdParamsSchema } from '@ilex/shared';
import { zodDto } from '../common/zod-dto.js';

export class CatalogIdParamsDto extends zodDto(catalogIdParamsSchema) {}
