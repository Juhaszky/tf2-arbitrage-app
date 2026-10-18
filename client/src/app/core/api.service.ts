import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { DealsResponse, ItemSearchResult, ItemStats, MarketFilter, MarketResponse } from './models';

const sku = (value: string) => encodeURIComponent(value);

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  getMarket() {
    return this.http.get<MarketResponse>('/api/market');
  }

  getItemStats(itemSku: string) {
    return this.http.get<ItemStats>(`/api/items/${sku(itemSku)}/stats`);
  }

  getDeals() {
    return this.http.get<DealsResponse>('/api/deals');
  }

  setFilter(filter: MarketFilter) {
    return this.http.put<MarketFilter>('/api/market/filter', filter);
  }

  setItemNotify(itemSku: string, notify: boolean) {
    return this.http.put<{ sku: string; name: string; notify: boolean }>(`/api/notifications/items/${sku(itemSku)}`, { notify });
  }

  setNotifyAllBuys(notifyAllBuys: boolean) {
    return this.http.put<{ notifyAllBuys: boolean }>('/api/notifications/settings', { notifyAllBuys });
  }

  searchItems(query: string) {
    return this.http.get<ItemSearchResult[]>('/api/items/search', { params: { q: query, limit: 15 } });
  }

  runCollector() {
    return this.http.post<{ message: string }>('/api/collector/run', {});
  }

  testNotification() {
    return this.http.post<{ message: string }>('/api/notifications/test', {});
  }
}
