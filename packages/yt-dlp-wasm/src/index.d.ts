export interface YtDlpOptions {
  /** URL of a CORS proxy for requests from a browser. */
  corsProxy?: string;
  /** Access key for the proxy. */
  corsProxyKey?: string;
  /**
   * The text of a Netscape cookies.txt file. `extractInfo` and `download` use it as `cookiefile`
   * unless their options set one. `run` adds `--cookies` unless the arguments have
   * `--cookies` or `--no-cookies`. It stays in memory and is never written to disk.
   */
  cookies?: string;
  /** Where Pyodide loads from. Defaults to jsDelivr in browsers and to the npm package in Node.js. */
  pyodideIndexURL?: string;
  /** Browser only. Where the ffmpeg.wasm core loads from. Defaults to jsDelivr. */
  ffmpegCoreURL?: string;
  /** Browser only. The yt-dlp wheel. Defaults to the package's dist/ folder next to this module. */
  wheelURL?: string;
  /** Environment variables for Python. */
  env?: Record<string, string>;
  /** Receives each line yt-dlp writes. */
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
}

/** yt-dlp's options as plain JSON, as passed to Python's `YoutubeDL`. Callbacks are not supported. */
export type YtDlpJsonOptions = Record<string, unknown>;

export type YtDlpProgress =
  | {
      type: 'download';
      status: 'downloading' | 'finished' | 'error';
      downloadedBytes: number | null;
      totalBytes: number | null;
      /** Bytes per second. */
      speed: number | null;
      /** Seconds left. */
      eta: number | null;
      filename: string | null;
    }
  | {
      type: 'postprocessor';
      status: 'started' | 'processing' | 'finished';
      postprocessor: string;
      filename: string | null;
    };

export interface DownloadOptions {
  onProgress?: (event: YtDlpProgress) => void;
  /** Node.js only. Where files are written. Defaults to the current directory. */
  outputDir?: string;
}

/** A file produced in a browser. The bytes are removed from the in-memory filesystem. */
export interface BrowserFile {
  name: string;
  data: Uint8Array;
  mimeType: string;
}

/** A file written to `outputDir` in Node.js. */
export interface NodeFile {
  name: string;
  path: string;
  size: number;
  mimeType: string;
}

export interface YtDlp {
  /** Runs yt-dlp with command-line arguments and resolves with the exit code. */
  run(args: string[]): Promise<number>;
  /** Resolves with the info dict. */
  extractInfo(url: string, options?: YtDlpJsonOptions): Promise<Record<string, any>>;
  /** `url` may also be an info dict from `extractInfo`, which skips extracting the page again. */
  download(url: string | Record<string, unknown>, options?: YtDlpJsonOptions, download?: DownloadOptions): Promise<Array<BrowserFile | NodeFile>>;
  /** Finishes the calls in progress, then releases Pyodide. */
  close(): Promise<void>;
  /** Stops now. Calls in progress reject. */
  terminate(): void;
}

export class YtDlpError extends Error {
  /** The Python exception class, such as `DownloadError`. */
  type?: string;
  traceback?: string;
}

/** Rejects if the runtime has no JSPI. */
export function createYtDlp(options?: YtDlpOptions): Promise<YtDlp>;
