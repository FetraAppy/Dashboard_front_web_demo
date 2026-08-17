import { Component, OnInit, AfterViewInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Chart, registerables } from 'chart.js';
import { environment } from '../../../environments/environment';
import { FormatService } from '../../shared/format.service';
Chart.register(...registerables);

interface OkrEntry {
  period_key: string;
  period_month: number;
  actual_value: number | null;
  target_value: number | null;
  variance_pct: number | null;
  status: string;
  kr_description?: string;
  target_label?: string;
}

@Component({
  selector: 'app-finance-tab',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './finance-tab.component.html',
})
export class FinanceTabComponent implements OnInit, AfterViewInit, OnDestroy {
  private charts: Chart[] = [];
  private viewReady = false;
  private dataReady = false;

  activeYear = '2026';
  loading = true;
  error = false;

  /** Nombre de mois à afficher (cutoff à la date du jour). */
  private get maxMonths(): number {
    const y = parseInt(this.activeYear);
    const now = new Date();
    if (y > now.getFullYear()) return 0;
    if (y === now.getFullYear()) return now.getMonth() + 1;
    return 12;
  }

  constructor(private fmt: FormatService, private cdr: ChangeDetectorRef) {}

  // Données chargées depuis l'API
  krMap: Record<string, OkrEntry[]> = {};
  latest: Record<string, OkrEntry & { owner?: string }> = {};

  // Données calculées pour les charts
  labels12: string[] = [];
  kr15Series: (number | null)[] = [];
  kr14Series: (number | null)[] = [];
  kr11Series: (number | null)[] = [];
  kr20Series: (number | null)[] = [];

  // KR24 — Ancienneté TEC (dimension bucket : montant par tranche)
  kr24Buckets: { label: string; kchf: number }[] = [];
  kr24Avg: number | null = null;

  ngOnInit() {
    this.fetchData();
  }

  ngAfterViewInit() {
    this.viewReady = true;
    if (this.dataReady) this.renderCharts();
  }

  ngOnDestroy() { this.charts.forEach(c => c.destroy()); }

  async fetchData() {
    this.loading = true;
    this.error = false;
    this.charts.forEach(c => c.destroy());
    this.charts = [];

    const safetyTimeout = setTimeout(() => {
      this.loading = false;
      this.error = true;
      this.buildFallbackSeries();
      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    }, 10000);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${environment.apiUrl}/api/okr/finance?annee=${this.activeYear}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      clearTimeout(safetyTimeout);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      this.krMap = json.kr_id_map || {};
      this.latest = json.latest || {};
      this.cdr.detectChanges();
      this.buildSeries();

      // KR24 — tranches d'ancienneté TEC (dimension bucket)
      try {
        const controller2 = new AbortController();
        const t2 = setTimeout(() => controller2.abort(), 8000);
        const resDim = await fetch(`${environment.apiUrl}/api/okr/dimensions?annee=${this.activeYear}`, { signal: controller2.signal });
        clearTimeout(t2);
        if (resDim.ok) {
          const dim = await resDim.json();
          const buckets = dim.dimensions?.['KR24']?.['bucket'] || {};
          this.kr24Buckets = Object.entries(buckets)
            .map(([label, entries]: any) => {
              let last: any = null;
              (entries || []).forEach((e: any) => { if (!last || e.period_month >= last.period_month) last = e; });
              return { label, kchf: last && last.actual_value !== null ? last.actual_value / 1000 : 0 };
            })
            .sort((a, b) => {
              const order = ['< 15j', '15-30j', '30-45j', '45-60j', '> 60j'];
              const ia = order.indexOf(a.label), ib = order.indexOf(b.label);
              return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            });
          this.kr24Avg = this.latest['KR24']?.actual_value ?? null;
          this.cdr.detectChanges();
        }
      } catch (e2) {
        console.error('[finance-tab] dimensions', e2);
      }

      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    } catch (e) {
      clearTimeout(safetyTimeout);
      console.error('[finance-tab]', e);
      this.error = true;
      this.buildFallbackSeries();
      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    } finally {
      this.loading = false;
    }
  }

  onYearChange() { this.fetchData(); }

  /** Construit des tableaux de 12 valeurs (null pour mois absents) */
  private buildSeries() {
    const n = this.maxMonths;
    this.labels12 = this.generateMonthLabels(parseInt(this.activeYear)).slice(0, n);
    const fill12 = (krId: string): (number | null)[] => {
      const arr: (number | null)[] = Array(Math.max(0, n)).fill(null);
      (this.krMap[krId] || []).forEach(e => {
        const idx = e.period_month - 1;
        if (idx >= 0 && idx < n) arr[idx] = e.actual_value;
      });
      return arr;
    };
    this.kr15Series = fill12('KR15').map(v => v !== null ? v / 1000 : null); // kCHF
    this.kr14Series = fill12('KR14').map(v => v !== null ? v / 1000 : null);
    this.kr11Series = fill12('KR11').map(v => v !== null ? v / 1000 : null);
    this.kr20Series = fill12('KR20');
  }

  private buildFallbackSeries() {
    const n = this.maxMonths;
    const M12 = ['Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc', 'Jan', 'Fév', 'Mar', 'Avr', 'Mai'];
    this.labels12 = M12.slice(0, n);
    this.kr15Series = [488, 502, null, 518, 525, 540, 505, 520, 528, 535, 539, 542].slice(0, n);
    this.kr14Series = [155, 158, 152, 162, 165, 170, 158, 165, 172, 175, 180, 187].slice(0, n);
    this.kr11Series = [980, 1050, 920, 1100, 1180, 1250, 1080, 1150, 1200, 1220, 1240, 1240].slice(0, n);
    this.kr20Series = [32, 30, 33, 31, 29, 28, 30, 29, 28, 29, 28, 28].slice(0, n);
    this.kr24Buckets = [
      { label: '< 15j', kchf: 890 }, { label: '15-30j', kchf: 320 },
      { label: '30-45j', kchf: 145 }, { label: '45-60j', kchf: 80 },
      { label: '> 60j', kchf: 42 },
    ];
    this.kr24Avg = 18;
  }

  private generateMonthLabels(year: number): string[] {
    const short = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
    return short.map(m => `${m} ${year}`);
  }

  /** Helper : valeur de la dernière entrée disponible ou null */
  getLatestVal(krId: string): number | null {
    return this.latest[krId]?.actual_value ?? null;
  }

  getLatestStatus(krId: string): string {
    return this.latest[krId]?.status ?? 'unknown';
  }

  getStatusBadge(status: string): string {
    switch (status) {
      case 'green': return 'b-ok';
      case 'orange': return 'b-warn';
      case 'red': return 'b-bad';
      default: return '';
    }
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'green': return '▲';
      case 'orange': return '⚠';
      case 'red': return '▼';
      default: return '—';
    }
  }

  formatVal(val: number | null, decimals = 0, unit = ''): string {
    if (val === null || val === undefined) return '—';
    return val.toFixed(decimals) + (unit ? ' ' + unit : '');
  }

  /** Montants monétaires (CHF) — paramétré centralement */
  money(val: number | null | undefined): string {
    return this.fmt.money(val);
  }

  /** Valeurs générales (%, x, j, h, pts, ratios…) — paramétré centralement */
  gen(val: number | null | undefined): string {
    return this.fmt.num(val);
  }

  private renderCharts() {
    this.charts.forEach(c => c.destroy());
    this.charts = [];

    const C = {
      fi: '#0047BB', fi20: '#D6E4F7',
      co: '#00BB31',
      rd: '#ef4444',
      ops: '#00C7B1', ops20: '#CCF5F1',
      dso: '#0094C6',
      gr: '#888888',
    };

    const mkNull = (arr: (number | null)[]) => arr;
    const firstTarget = (krId: string): number | null =>
      this.krMap[krId]?.[0]?.target_value ?? null;
    const n = this.labels12.length;

    // KR15 CA mensuel (bar + line N-1 mock)
    const el15 = document.getElementById('fi-kr15') as HTMLCanvasElement | null;
    if (el15) {
      const target15 = firstTarget('KR15');
      const targetSeries15 = target15 ? Array(n).fill(target15 / 1000) : Array(n).fill(540);
      this.charts.push(new Chart(el15.getContext('2d')!, {
        type: 'bar',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Budget', data: targetSeries15, backgroundColor: C.fi20, borderColor: C.fi, borderWidth: 1 },
            { label: 'Réalisé', data: mkNull(this.kr15Series) as any, backgroundColor: C.fi } as any,
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } }, scales: { y: { min: 0 } } }
      }));
    }

    // KR14 Marge Brute 2
    const el14 = document.getElementById('fi-kr14') as HTMLCanvasElement | null;
    if (el14) {
      const target14 = firstTarget('KR14');
      const tSeries14 = target14 ? Array(n).fill(target14 / 1000) : Array(n).fill(175);
      this.charts.push(new Chart(el14.getContext('2d')!, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'MB2 (kCHF)', data: mkNull(this.kr14Series) as any, borderColor: C.fi, backgroundColor: 'rgba(0, 71, 187, 0.08)', fill: true, tension: 0.3, borderWidth: 2 },
            { label: 'Budget', data: tSeries14, borderColor: C.gr, borderDash: [5, 5], borderWidth: 1.5, fill: false, pointRadius: 0 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } }, scales: { y: { min: 0 } } }
      }));
    }

    // KR11 Trésorerie
    const el11 = document.getElementById('fi-kr11') as HTMLCanvasElement | null;
    if (el11) {
      const target11 = firstTarget('KR11');
      const seuil = target11 ? target11 / 1000 : 500;
      this.charts.push(new Chart(el11.getContext('2d')!, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Trésorerie (kCHF)', data: mkNull(this.kr11Series) as any, borderColor: C.ops, backgroundColor: C.ops20 + '66', fill: true, tension: 0.3, borderWidth: 2 },
            { label: `Seuil ${seuil}k`, data: Array(n).fill(seuil), borderColor: C.rd, borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } } }
      }));
    }

    // KR20 DSO + KR21 Perte/CA
    const el2021 = document.getElementById('fi-kr2021') as HTMLCanvasElement | null;
    if (el2021) {
      const dsoTarget = firstTarget('KR20') ?? 45;
      this.charts.push(new Chart(el2021.getContext('2d')!, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'DSO (jours)', data: mkNull(this.kr20Series) as any, borderColor: C.dso, tension: 0.3, borderWidth: 2, fill: false, yAxisID: 'y' },
            { label: `Cible DSO ≤${dsoTarget}j`, data: Array(n).fill(dsoTarget), borderColor: C.dso, borderDash: [5, 5], borderWidth: 1.5, fill: false, pointRadius: 0, yAxisID: 'y' },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } },
          scales: {
            y: { min: 0, ticks: { callback: (v: any) => v + 'j' } },
          }
        }
      }));
    }

    // KR24 TEC Aging (données réelles — kpi.okr_monthly, dimension bucket)
    const el24 = document.getElementById('fi-kr24') as HTMLCanvasElement | null;
    if (el24) {
      const labels = this.kr24Buckets.length ? this.kr24Buckets.map(b => b.label) : ['Aucune donnée'];
      const values = this.kr24Buckets.length ? this.kr24Buckets.map(b => b.kchf) : [0];
      this.charts.push(new Chart(el24.getContext('2d')!, {
        type: 'bar',
        data: {
          labels,
          datasets: [{ label: 'Factures (kCHF)', data: values, backgroundColor: ['#22c55e', '#14b8a6', '#eab308', '#f97316', '#ef4444'] }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
      }));
    }
  }
}
