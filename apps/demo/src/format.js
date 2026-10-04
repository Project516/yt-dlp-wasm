export function formatBytes(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let unit = 0;
  while (bytes >= 1000 && unit < units.length - 1) {
    bytes /= 1000;
    unit++;
  }
  return `${bytes.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  if (!seconds) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatEta(seconds) {
  if (seconds == null) return '';
  const total = Math.round(seconds);
  if (total < 60) return `${total} s left`;
  if (total < 3600) return `${Math.floor(total / 60)} min ${total % 60} s left`;
  return `${Math.floor(total / 3600)} h ${Math.floor((total % 3600) / 60)} min left`;
}
