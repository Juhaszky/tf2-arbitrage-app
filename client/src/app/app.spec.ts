import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { TrackedResponse } from './core/models';

const emptyResponse: TrackedResponse = {
  items: [],
  analyzedAt: null,
  keyPriceMetal: 65.11,
  collector: { running: false },
  discord: { configured: true },
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

  it('should show the empty state when nothing is tracked', async () => {
    const fixture = TestBed.createComponent(App);
    TestBed.inject(HttpTestingController).expectOne('/api/tracked').flush(emptyResponse);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.title')?.textContent).toContain('TF2 Arbitrage');
    expect(compiled.querySelector('.empty')?.textContent).toContain('Még nem követsz');
  });
});
