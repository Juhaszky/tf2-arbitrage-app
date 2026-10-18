import { FileStore } from '../storage/file.store';

/** A mannco.store tárgylistájának egy sora (`GET /item/prices`). Az ár USD centben. */
export interface ManncoPriceRow {
  name: string;
  craftable: number;
  effect: string;
  url: string;
  assetcount: number;
  price: number;
  item_id: number;
  /** Az utolsó változás ideje (unix mp). */
  lastmod: number;
}

/** Napi eladási adat (`GET /item/salesGraph`): átlagár centben és a darabszám. */
export interface ManncoSalesDay {
  date: string;
  price: number;
  nb: number;
}

export interface ManncoPricing {
  lowest_sale_price: number | null;
  lowest_buy_order: number | null;
  steam_price: number | null;
  suggested_price: number | null;
  last_sale?: { price: number; date: number } | null;
}

export interface ManncoBulkPricingItem {
  item_id: number;
  last_updated?: string;
  stale?: boolean;
  pricing: ManncoPricing;
}

export class ManncoError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

interface Envelope<T> {
  err: boolean;
  success: boolean;
  content: T;
}

interface Session {
  jwt: string;
  /** Unix másodperc. */
  exp: number;
}

const BASE_URL = 'https://api.mannco.store';
const TF2 = 440;
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 60_000;
const SESSION_FILE = 'mannco-session.json';
/** A tömeges árazó percenként 10 kérést enged. */
const BULK_INTERVAL_MS = 6_500;
/** Ennyivel a lejárat előtt már új tokent kérünk. */
const RENEW_BEFORE_SECONDS = 86_400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeExp = (jwt: string): number => {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch {
    return 0;
  }
};

/**
 * mannco.store API kliens. Az API kulcsot JWT-re cseréli (`POST /user/login`, kb. 31 napig érvényes, a
 * bejelentkezéskori IP-hez kötött), a tokent a data mappában megjegyzi, és 401/403 esetén egyszer újra
 * bejelentkezik. Minden kérés között `delayMs` szünetet tart, 429-nél a `Retry-After` szerint vár.
 */
export class ManncoClient {
  private session?: Session;
  private nextRequestAt = 0;
  private nextBulkAt = 0;
  public requestCount = 0;

  constructor(
    private apiKey: string | undefined,
    private store: FileStore,
    private delayMs = 200,
  ) {}

  get isConfigured() {
    return !!this.apiKey;
  }

  /**
   * A készleten lévő TF2 tárgyak ajánlatai (ár, készlet). `outOfStock` esetén ehelyett csak a nem készleten
   * lévő tárgyak listáját adja, ár és készlet nélkül. A mannco 5 percenként egy ilyen kérést enged.
   */
  getPrices(outOfStock = false) {
    return this.get<ManncoPriceRow[]>(`/item/prices?game=${TF2}&outofstock=${outOfStock ? 1 : 0}`);
  }

  /** Napi eladások az elmúlt időszakban (darab és átlagár). */
  async getSalesGraph(slug: string, period: '1M' | '3M' | '6M' | '1Y' = '3M') {
    const content = await this.get<{ values?: ManncoSalesDay[] } | ManncoSalesDay[]>(
      `/item/salesGraph/${encodeURIComponent(slug)}?period=${period}`,
    );
    return Array.isArray(content) ? content : content?.values ?? [];
  }

  /**
   * Árazás legfeljebb 100 tárgyra egyszerre (numerikus mannco azonosítóval). A `lowest_buy_order` a neve
   * ellenére a **legmagasabb** buy order (a kulcsnál pl. 174 cent, a legolcsóbb ajánlat 175). A mannco
   * percenként 10 ilyen kérést enged, ezért ezek külön ütemezővel, legalább 6,5 másodpercenként mennek.
   */
  async getBulkPricing(itemIds: number[]): Promise<ManncoBulkPricingItem[]> {
    if (itemIds.length === 0) return [];
    if (itemIds.length > 100) throw new ManncoError('Egy kérésben legfeljebb 100 tárgy árazható.');
    const wait = this.nextBulkAt - Date.now();
    if (wait > 0) await sleep(wait);
    this.nextBulkAt = Date.now() + BULK_INTERVAL_MS;
    const content = await this.get<{ items?: ManncoBulkPricingItem[] }>(`/item/pricing/bulk?items=${itemIds.join(',')}`);
    return content?.items ?? [];
  }

  /** Legolcsóbb ajánlat, legmagasabb vételi ajánlat, Steam ár és utolsó eladás (a mannco 20 percig gyorsítótárazza). */
  async getPricing(slug: string) {
    const content = await this.get<{ pricing: ManncoPricing }>(`/item/pricing/${encodeURIComponent(slug)}`);
    return content.pricing;
  }

  private async token(forceLogin = false): Promise<string> {
    if (!this.apiKey) throw new ManncoError('Nincs beállítva a MANNCO_API_KEY.');
    const now = Date.now() / 1000;
    if (!forceLogin) {
      this.session ??= (await this.store.read<Session | null>(SESSION_FILE, null)) ?? undefined;
      if (this.session && this.session.exp - RENEW_BEFORE_SECONDS > now) return this.session.jwt;
    }

    await this.throttle();
    this.requestCount++;
    const res = await fetch(`${BASE_URL}/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ apiKey: this.apiKey }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Envelope<{ jwt?: string } | string> | null;
    const jwt = body && typeof body.content === 'object' ? body.content?.jwt : undefined;
    if (!res.ok || !jwt) {
      const reason = typeof body?.content === 'string' ? body.content : `HTTP ${res.status}`;
      throw new ManncoError(`A mannco.store bejelentkezés sikertelen: ${reason}`, res.status);
    }
    this.session = { jwt, exp: decodeExp(jwt) || now + 30 * 86_400 };
    await this.store.write(SESSION_FILE, this.session);
    return jwt;
  }

  private async throttle() {
    const wait = this.nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    this.nextRequestAt = Date.now() + this.delayMs;
  }

  private async get<T>(path: string): Promise<T> {
    let relogged = false;
    for (let attempt = 1; ; attempt++) {
      const jwt = await this.token();
      await this.throttle();
      this.requestCount++;

      let res: Response;
      try {
        res = await fetch(BASE_URL + path, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${jwt}`, 'User-Agent': 'tf2-arbitrage-app/1.0' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw new ManncoError(`Hálózati hiba (${path}): ${(error as Error).message}`);
        await sleep(5000 * 2 ** (attempt - 1));
        continue;
      }

      // Lejárt vagy más IP-hez kötött token: egyszer újra bejelentkezünk
      if ((res.status === 401 || res.status === 403) && !relogged) {
        relogged = true;
        await this.token(true);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) throw new ManncoError(`mannco.store ${res.status} (${path})`, res.status);
        const seconds = Number(res.headers.get('retry-after'));
        await sleep(seconds > 0 ? seconds * 1000 : 5000 * 2 ** (attempt - 1));
        continue;
      }

      const body = (await res.json().catch(() => null)) as Envelope<T> | T | null;
      // A dokumentációval ellentétben egyes végpontok (pl. /item/prices) boríték nélkül, csupasz tömböt adnak
      if (res.ok && Array.isArray(body)) return body as T;
      if (!res.ok || !body || (body as Envelope<T>).err) {
        const content = (body as Envelope<T> | null)?.content;
        const reason = typeof content === 'string' ? content : `HTTP ${res.status}`;
        throw new ManncoError(`mannco.store hiba (${path}): ${reason}`, res.status);
      }
      return (body as Envelope<T>).content;
    }
  }
}
