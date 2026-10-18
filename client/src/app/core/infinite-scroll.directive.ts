import { Directive, ElementRef, OnDestroy, afterNextRender, inject, input, output } from '@angular/core';

/**
 * Végtelen görgetés: jelez, amikor az elem (a lista alján lévő jelölő) a nézet közelébe ér, hogy a lista a
 * következő adagot is megjelenítse. A `rootMargin` miatt kicsit előbb tölt, így görgetés közben nem kell várni.
 * Az IntersectionObserver csak a belépéskor jelez; ha egy adag után a jelölő még mindig a nézetben van (nagy
 * képernyő, rövid kártyák), újra ellenőrizzük, amíg van még mit betölteni (`hasMore`).
 */
@Directive({ selector: '[appInfiniteScroll]' })
export class InfiniteScroll implements OnDestroy {
  readonly hasMore = input(true);
  /** Ennyivel a nézet alja előtt jelez (CSS margó). */
  readonly rootMargin = input('800px');
  readonly reached = output<void>();

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private observer?: IntersectionObserver;
  private frame?: number;

  constructor() {
    afterNextRender(() => {
      if (typeof IntersectionObserver === 'undefined') return;
      this.observer = new IntersectionObserver(
        (entries) => {
          if (!this.hasMore() || !entries.some((e) => e.isIntersecting)) return;
          this.reached.emit();
          // A következő képkocka után (amikor az új kártyák már a lapon vannak) újra megnézzük a jelölőt
          this.frame = requestAnimationFrame(() => {
            const el = this.element.nativeElement;
            this.observer?.unobserve(el);
            this.observer?.observe(el);
          });
        },
        { rootMargin: `0px 0px ${this.rootMargin()} 0px` },
      );
      this.observer.observe(this.element.nativeElement);
    });
  }

  ngOnDestroy() {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
  }
}
