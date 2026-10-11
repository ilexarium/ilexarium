import { changePasswordRequestSchema, loginRequestSchema } from '@homelab/shared';
import { zodDto } from '../common/zod-dto.js';

export class LoginDto extends zodDto(loginRequestSchema) {}
export class ChangePasswordDto extends zodDto(changePasswordRequestSchema) {}
