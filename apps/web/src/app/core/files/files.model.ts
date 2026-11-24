/** One file of the uploads list: waiting for its turn, on its way, or finished. */
export interface Upload {
  id: number;
  name: string;
  /** 0–1. */
  progress: number;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
}

/** The files of one pick or drop, into one folder; `replace` false: a name taken there is asked about. */
export interface UploadRequest {
  folder: string;
  files: File[];
  replace: boolean;
}

/** A file whose name was taken in the folder it went to: asked about before replacing it. */
export interface UploadClash {
  folder: string;
  file: File;
}
