import {
  changePasswordRequestSchema,
  loginRequestSchema,
  setupRequestSchema,
} from '@homelab/shared';
import { zodDto } from '../common/zod-dto.js';

export class LoginDto extends zodDto(loginRequestSchema) {}
export class ChangePasswordDto extends zodDto(changePasswordRequestSchema) {}
export class SetupDto extends zodDto(setupRequestSchema) {}
