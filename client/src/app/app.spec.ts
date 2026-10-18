import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { MarketResponse } from './core/models';

const emptyResponse: MarketResponse = {
  items: [],
  analyzedAt: null,
  keyPriceMetal: 65.11,
  screen: null,
  mannco: { configured: false, matched: null, profitableNow: null, keyPriceUsd: null },
  filter: { minKeys: null, maxKeys: null, qualities: [] },
  hiddenByFilter: 0,
  filterPending: false,
  qualities: [{ id: 'strange', label: 'Strange' }],
  collector: { running: false },
  discord: { configured: true },
  notifications: { notifyAllBuys: false },
};

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should show the empty state before the first analysis', async () => {
    const fixture = TestBed.createComponent(App);
    TestBed.inject(HttpTestingController).expectOne('/api/market').flush(emptyResponse);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.title')?.textContent).toContain('TF2 Arbitrage');
    expect(compiled.querySelector('.empty')?.textContent).toContain('Még nincs elemzett tárgy');
  });
});
