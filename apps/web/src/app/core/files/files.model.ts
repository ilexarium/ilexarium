export interface Upload {
  id: number;
  name: string;
  /** 0–1. */
  progress: number;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
}

/** One pick or drop; `replace` false: a name taken there is asked about. */
export interface UploadRequest {
  folder: string;
  files: File[];
  replace: boolean;
}

export interface UploadClash {
  folder: string;
  file: File;
}
