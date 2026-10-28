import {
  filePathQuerySchema,
  fileRenameRequestSchema,
  fileUploadQuerySchema,
  linuxSignInRequestSchema,
  linuxSudoRequestSchema,
  newFolderRequestSchema,
} from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class LinuxSignInDto extends zodDto(linuxSignInRequestSchema) {}
export class LinuxSudoDto extends zodDto(linuxSudoRequestSchema) {}
export class FilePathQueryDto extends zodDto(filePathQuerySchema) {}
export class FileUploadQueryDto extends zodDto(fileUploadQuerySchema) {}
export class NewFolderDto extends zodDto(newFolderRequestSchema) {}
export class FileRenameDto extends zodDto(fileRenameRequestSchema) {}
