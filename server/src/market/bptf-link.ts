import type { PriceDbItem } from '../clients/pricedb.client';

const QUALITY_NAMES: Record<number, string> = {
  0: 'Normal',
  1: 'Genuine',
  3: 'Vintage',
  5: 'Unusual',
  6: 'Unique',
  9: 'Self-Made',
  11: 'Strange',
  13: 'Haunted',
  14: "Collector's",
  15: 'Decorated Weapon',
};

/** A pricedb név elején ezek a minőségek szerepelnek; a backpack.tf statisztika-oldalán a név nélkülük van. */
const NAME_PREFIXES: Record<number, string> = {
  1: 'Genuine ',
  3: 'Vintage ',
  11: 'Strange ',
  13: 'Haunted ',
  14: "Collector's ",
};

/**
 * backpack.tf statisztika-oldal (`/stats/{minőség}/{név}/Tradable/{Craftable|Non-Craftable}/{priceindex}`) az SKU-ból és a
 * pricedb névből. A pricedb név tartalmazza a minőséget és unusualnál az effektet is; ezeket elhagyjuk:
 * - unusualnál a tárgy unique (6-os minőségű, effekt nélküli) változatának nevét használjuk, az effekt azonosítója
 *   (`u{id}`) a priceindex;
 * - a `Non-Craftable` jelző és a `Festivized` nem része a névnek;
 * - ládáknál a sorozatszám (`c{n}`) a priceindex.
 * A kit fabricatoroknál és egyéb összetett tárgyaknál a link az alaptárgy oldalára mutat.
 */
export function bptfStatsUrl(sku: string, name: string, namesBySku: Map<string, string>): string {
  const parts = sku.split(';');
  const quality = Number(parts[1]);
  const craftable = !parts.includes('uncraftable');
  const effect = parts.find((p) => /^u\d+$/.test(p))?.slice(1);
  const crate = parts.find((p) => /^c\d+$/.test(p))?.slice(1);
  const elevatedStrange = parts.includes('strange') && quality !== 11;

  let base = name.replace(/Non-Craftable /g, '').replace(/Festivized /g, '');
  if (elevatedStrange && base.startsWith('Strange ')) base = base.slice('Strange '.length);
  const prefix = NAME_PREFIXES[quality];
  if (prefix && base.startsWith(prefix)) base = base.slice(prefix.length);

  if (quality === 5 && effect) {
    // Ugyanaz a tárgy unique minőségben, effekt nélkül (a többi tag, pl. killstreak, marad)
    const uniqueSku = [parts[0], '6', ...parts.slice(2).filter((p) => p !== `u${effect}` && p !== 'strange')].join(';');
    const uniqueName = namesBySku.get(uniqueSku) ?? namesBySku.get(`${parts[0]};6`);
    base = uniqueName ? uniqueName.replace(/Non-Craftable /g, '') : base.split(' ').slice(1).join(' ');
  }

  const qualityName = `${elevatedStrange ? 'Strange ' : ''}${QUALITY_NAMES[quality] ?? 'Unique'}`;
  const priceIndex = effect ?? crate;
  return [
    'https://backpack.tf/stats',
    encodeURIComponent(qualityName),
    encodeURIComponent(base.trim()),
    'Tradable',
    craftable ? 'Craftable' : 'Non-Craftable',
    ...(priceIndex ? [priceIndex] : []),
  ].join('/');
}

let memo: { items: PriceDbItem[]; index: Map<string, string> } | undefined;

/** SKU → név a pricedb tárgylistából, a linkekhez (ugyanarra a listára csak egyszer épül fel). */
export function namesIndex(items: PriceDbItem[]) {
  if (memo?.items !== items) memo = { items, index: new Map(items.map((i) => [i.sku, i.name])) };
  return memo.index;
}
