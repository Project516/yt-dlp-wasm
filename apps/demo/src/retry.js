// YouTube flags the shared IP addresses Cloudflare Workers fetch from on some
// requests and not others, so another try often gets through.
const FLAGGED = /not a bot|HTTP Error 429/;

export const RETRIES = 3;

export function flagged(error) {
  return FLAGGED.test(String(error?.message ?? error));
}

export async function retryFlagged(fn, { retries = RETRIES, delay = 1500, onRetry = () => {}, canceled = () => false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt > retries || !flagged(error) || canceled()) throw error;
      onRetry(attempt, retries);
      await new Promise((resolve) => setTimeout(resolve, delay * attempt));
      if (canceled()) throw error;
    }
  }
}
