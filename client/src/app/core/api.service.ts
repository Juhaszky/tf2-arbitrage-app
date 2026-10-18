import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { ItemSearchResult, TrackedItem, TrackedResponse } from './models';

const sku = (value: string) => encodeURIComponent(value);

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  getTracked() {
    return this.http.get<TrackedResponse>('/api/tracked');
  }

  addTracked(itemSku: string, notify = true) {
    return this.http.post<TrackedItem>('/api/tracked', { sku: itemSku, notify });
  }

  setNotify(itemSku: string, notify: boolean) {
    return this.http.patch<TrackedItem>(`/api/tracked/${sku(itemSku)}`, { notify });
  }

  removeTracked(itemSku: string) {
    return this.http.delete<void>(`/api/tracked/${sku(itemSku)}`);
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
