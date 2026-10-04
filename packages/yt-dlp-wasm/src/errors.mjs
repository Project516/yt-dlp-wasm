// An error raised by yt-dlp. `type` is the Python exception class, such as `DownloadError`.
export class YtDlpError extends Error {
  constructor(message, { type, traceback } = {}) {
    super(message);
    this.name = 'YtDlpError';
    this.type = type;
    this.traceback = traceback;
  }
}
