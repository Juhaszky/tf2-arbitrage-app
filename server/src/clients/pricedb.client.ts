import { HistoryEntry } from '../services/arbitrage.service';

export interface PriceDbItem {
  name: string;
  sku: string;
}

export class PriceDbError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * pricedb.io kliens. Minden kérés között legalább `delayMs` (+ legfeljebb 50% véletlen) szünetet tart,
 * 429-es és 5xx válasznál a szerver által kért ideig vár, majd újrapróbálja.
 */
export class PriceDbClient {
  private nextRequestAt = 0;
  public requestCount = 0;

  constructor(private baseUrl: string, private delayMs: number) {}

  getItems() {
    return this.get<PriceDbItem[]>('/items');
  }

  getItemHistory(sku: string) {
    return this.get<HistoryEntry[]>(`/item-history/${encodeURIComponent(sku)}`);
  }

  private async throttle() {
    const wait = this.nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    this.nextRequestAt = Date.now() + this.delayMs * (1 + Math.random() * 0.5);
  }

  private async get<T>(path: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      this.requestCount++;

      let res: Response;
      try {
        res = await fetch(this.baseUrl + path, {
          headers: { Accept: 'application/json', 'User-Agent': 'tf2-arbitrage-app/1.0' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw new PriceDbError(`Hálózati hiba (${path}): ${(error as Error).message}`);
        await sleep(this.backoffMs(attempt));
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) throw new PriceDbError(`pricedb.io ${res.status} (${path})`, res.status);
        await sleep(this.retryAfterMs(res) ?? this.backoffMs(attempt));
        continue;
      }
      if (!res.ok) throw new PriceDbError(`pricedb.io ${res.status} (${path})`, res.status);

      // Ha majdnem elfogyott a keret, megvárjuk a következő időablakot
      if (Number(res.headers.get('ratelimit-remaining')) <= 2) {
        const resetMs = Number(res.headers.get('ratelimit-reset')) * 1000;
        if (resetMs > 0) this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + resetMs);
      }
      return (await res.json()) as T;
    }
  }

  private retryAfterMs(res: Response): number | undefined {
    const seconds = Number(res.headers.get('retry-after') ?? res.headers.get('ratelimit-reset'));
    return seconds > 0 ? seconds * 1000 : undefined;
  }

  private backoffMs(attempt: number) {
    return 5000 * 2 ** (attempt - 1);
  }
}
