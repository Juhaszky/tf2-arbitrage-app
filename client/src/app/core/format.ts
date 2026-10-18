import { Analysis, Money, Recommendation, RiskLevel } from './models';

export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  BUY: 'Vétel',
  WATCH: 'Figyeld',
  INSUFFICIENT_DATA: 'Kevés adat',
  AVOID: 'Kerüld',
};

export const RECOMMENDATION_ICONS: Record<Recommendation, string> = {
  BUY: 'shopping_cart',
  WATCH: 'visibility',
  INSUFFICIENT_DATA: 'hourglass_empty',
  AVOID: 'block',
};

export const RISK_LABELS: Record<RiskLevel, string> = {
  LOW: 'Alacsony',
  MEDIUM: 'Közepes',
  HIGH: 'Magas',
};

/** A legjobb útvonal ajánlása (a korábbi, mannco előtti elemzésekben a backpack.tf útvonalé). */
export const bestRecommendation = (a: Analysis): Recommendation => a.bestRoute?.recommendation ?? a.recommendation;

/** A legjobb útvonal óvatos haszna kulcsban. */
export const bestProfitKeys = (a: Analysis): number => a.bestRoute?.conservativeProfitKeys ?? a.profit.conservativeProfitKeys;

export const formatUsd = (value: number) =>
  value.toLocaleString('hu-HU', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const number = (value: number, digits = 2) =>
  value.toLocaleString('hu-HU', { maximumFractionDigits: digits });

/** Ár kulcs + ref formában; ha a szerver nem bontotta fel, kulcsban. */
export function formatMoney(money: Money | null, keys: number): string {
  if (!money) return `${number(keys)} kulcs`;
  const parts = [];
  if (money.keys) parts.push(`${money.keys} kulcs`);
  if (money.metal || !money.keys) parts.push(`${number(money.metal)} ref`);
  return parts.join(' + ');
}

export const formatKeys = (keys: number) => `${number(keys)} kulcs`;

export const formatPercent = (value: number) => `${number(value, 1)}%`;

export function timeAgo(iso: string | null): string {
  if (!iso) return 'még soha';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'épp most';
  if (minutes < 60) return `${minutes} perce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} órája`;
  return `${Math.round(hours / 24)} napja`;
}
