import { catalogIdParamsSchema, deployRequestSchema, serviceIdParamsSchema } from '@homelab/shared';
import { zodDto } from '../common/zod-dto.js';

export class DeployDto extends zodDto(deployRequestSchema) {}
export class CatalogIdParamsDto extends zodDto(catalogIdParamsSchema) {}
export class ServiceIdParamsDto extends zodDto(serviceIdParamsSchema) {}
