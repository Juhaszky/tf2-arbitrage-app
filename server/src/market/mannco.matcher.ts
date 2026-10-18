import type { ManncoPriceRow } from '../clients/mannco.client';

/** Egy tárgy legolcsóbb mannco ajánlata. Az ár USD centben, a `stock` az ezen az áron elérhető darabszám. */
export interface ManncoOffer {
  name: string;
  effect: string;
  url: string;
  itemId: number;
  priceCents: number;
  stock: number;
  /** Az összes listázott darab, minden árszinten. */
  totalStock: number;
  lastmod: number;
}

/**
 * Közös kulcs a pricedb és a mannco.store tárgyneveihez. A két oldal eltérően írja ugyanazt a tárgyat:
 * - unusual: pricedb `Scorching Flames Brown Bomber`, mannco `Unusual Brown Bomber` + effekt `★ Scorching Flames`;
 * - mannco gyakran elé teszi a `The` szót (`The Brown Bomber`), a pricedb nem;
 * - nem craftolható: pricedb `Non-Craftable …` a névben, mannco `craftable: 0` mezőben;
 * - az előtagok (Strange, Festivized, Killstreak…) sorrendje eltérhet.
 * Ezért a kulcs a név szavainak rendezett halmaza a `the` és a craftolhatóság szavai nélkül, plusz a craftolhatóság.
 */
const STOP_WORDS = new Set(['the', 'non', 'craftable', 'uncraftable']);

const tokens = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !STOP_WORDS.has(t));

const keyOf = (words: string[], craftable: boolean) => `${[...words].sort().join(' ')}|${craftable ? 1 : 0}`;

/** A pricedb tárgy kulcsa az SKU (craftolhatóság) és a név alapján. */
export const pricedbKey = (sku: string, name: string) => keyOf(tokens(name), !sku.split(';').includes('uncraftable'));

/** A mannco sor kulcsa; unusual effekt esetén az `Unusual` szó helyett az effekt neve kerül a kulcsba. */
export function manncoKey(row: Pick<ManncoPriceRow, 'name' | 'effect' | 'craftable'>) {
  const effect = row.effect?.replace(/★/g, '').trim();
  let words = tokens(row.name);
  if (effect) {
    const i = words.indexOf('unusual');
    if (i >= 0) words.splice(i, 1);
    words = [...words, ...tokens(effect)];
  }
  return keyOf(words, row.craftable !== 0);
}

/**
 * A mannco árlistából kulcsonként a legolcsóbb ajánlat. Ugyanaz a tárgy több sorban is szerepelhet
 * (árszintek, illetve festett vagy spelles példányok azonos névvel); a legolcsóbb a sima változat, és a
 * pricedb is azt árazza.
 */
export function indexManncoOffers(rows: ManncoPriceRow[]): Map<string, ManncoOffer> {
  const offers = new Map<string, ManncoOffer>();
  for (const row of rows) {
    if (!row?.name || !(row.price > 0) || !(row.assetcount > 0)) continue;
    const key = manncoKey(row);
    const existing = offers.get(key);
    if (existing) {
      existing.totalStock += row.assetcount;
      if (row.price >= existing.priceCents) continue;
    }
    offers.set(key, {
      name: row.name,
      effect: row.effect ?? '',
      url: row.url,
      itemId: row.item_id,
      priceCents: row.price,
      stock: row.assetcount,
      totalStock: (existing?.totalStock ?? 0) + (existing ? 0 : row.assetcount),
      lastmod: row.lastmod,
    });
  }
  return offers;
}
