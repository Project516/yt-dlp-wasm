const TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', opus: 'audio/ogg', ogg: 'audio/ogg', oga: 'audio/ogg',
  wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  vtt: 'text/vtt', srt: 'application/x-subrip', json: 'application/json', txt: 'text/plain',
};

export function mimeTypeOf(name) {
  return TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}
