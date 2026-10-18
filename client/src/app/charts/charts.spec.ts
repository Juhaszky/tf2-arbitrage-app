import { TestBed } from '@angular/core/testing';
import { niceDomain, niceTicks, stepValueAt } from './chart-utils';
import { CheckBars } from './check-bars';

describe('chart-utils', () => {
  it('kerek tengelyfeliratokat ad', () => {
    expect(niceTicks(0, 97, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    // A feliratok a teljes tartományt lefedik: -12,5 alatt -15, 7 fölött 10
    expect(niceTicks(-12.5, 7, 4)).toEqual([-15, -10, -5, 0, 5, 10]);
  });

  it('a tartományt a feliratokhoz igazítja, és a nulla szélességű tartományt kitágítja', () => {
    expect(niceDomain(3, 97)).toEqual([0, 100]);
    const [lo, hi] = niceDomain(5, 5);
    expect(lo).toBeLessThan(5);
    expect(hi).toBeGreaterThan(5);
  });

  it('a lépcsős idősor értéke az utolsó, nem későbbi pont', () => {
    const points = [{ t: 10, v: 1 }, { t: 20, v: 2 }, { t: 30, v: 3 }];
    expect(stepValueAt(points, 5)).toBeNull();
    expect(stepValueAt(points, 10)).toBe(1);
    expect(stepValueAt(points, 25)).toBe(2);
    expect(stepValueAt(points, 99)).toBe(3);
  });
});

describe('CheckBars', () => {
  it('a sávot az értékig, a jelölőt a küszöbhöz rajzolja, és a nagyon kilógó értéket levágja', async () => {
    const fixture = TestBed.createComponent(CheckBars);
    fixture.componentRef.setInput('checks', [
      { id: 'WIN_RATE', category: 'risk', passed: true, value: 95, threshold: 90, message: 'ok' },
      { id: 'SALE_SPEED', category: 'risk', passed: false, value: 9999, threshold: 14, message: 'nincs eladás' },
    ]);
    await fixture.whenStable();
    const rows = (fixture.componentInstance as unknown as { rows: () => { fillWidth: number; thresholdPos: number; overflow: boolean; valueText: string }[] }).rows();
    expect(rows[0].thresholdPos).toBeLessThan(rows[0].fillWidth);
    expect(rows[0].overflow).toBe(false);
    expect(rows[1].overflow).toBe(true);
    expect(rows[1].valueText).toBe('nincs eladás');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Nyerési arány a visszatesztben');
    expect(text).toContain('Teljesült');
    expect(text).toContain('Nem teljesült');
  });
});
