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
  selector: 'app-rh-tab',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './rh-tab.component.html',
})
export class RhTabComponent implements OnInit, AfterViewInit, OnDestroy {
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

  krMap: Record<string, OkrEntry[]> = {};
  latest: Record<string, OkrEntry & { owner?: string }> = {};

  labels12: string[] = [];
  kr01Entries: OkrEntry[] = [];
  kr06Series: (number | null)[] = [];

  // KR02 — Heures supp / vacances / solde (dimension detail)
  kr02Detail: { vacances: (number | null)[]; hs: (number | null)[]; solde: (number | null)[] } = {
    vacances: [], hs: [], solde: [],
  };

  ngOnInit() { this.fetchData(); }

  /** Valeurs générales (%, x, j, h, pts, ratios…) — paramétré centralement */
  gen(val: number | null | undefined): string {
    return this.fmt.num(val);
  }

  constructor(private fmt: FormatService, private cdr: ChangeDetectorRef) {}

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
      const res = await fetch(`${environment.apiUrl}/api/okr/rh?annee=${this.activeYear}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      clearTimeout(safetyTimeout);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      this.krMap = json.kr_id_map || {};
      this.latest = json.latest || {};
      this.cdr.detectChanges();
      this.buildSeries();

      // KR02 — détail HS / vacances / solde (dimension detail)
      try {
        const controller2 = new AbortController();
        const t2 = setTimeout(() => controller2.abort(), 8000);
        const resDim = await fetch(`${environment.apiUrl}/api/okr/dimensions?annee=${this.activeYear}`, { signal: controller2.signal });
        clearTimeout(t2);
        if (resDim.ok) {
          const dim = await resDim.json();
          const n = this.maxMonths;
          const series = (key: string): (number | null)[] => {
            const arr: (number | null)[] = Array(n).fill(null);
            (dim.dimensions?.['KR02']?.['detail']?.[key] || []).forEach((e: any) => {
              const idx = e.period_month - 1;
              if (idx >= 0 && idx < n) arr[idx] = e.actual_value;
            });
            return arr;
          };
          this.kr02Detail = { vacances: series('vacances'), hs: series('hs'), solde: series('solde') };
          this.cdr.detectChanges();
        }
      } catch (e2) {
        console.error('[rh-tab] dimensions', e2);
      }

      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    } catch (e) {
      clearTimeout(safetyTimeout);
      console.error('[rh-tab]', e);
      this.error = true;
      this.buildFallbackSeries();
      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    } finally {
      this.loading = false;
    }
  }

  onYearChange() { this.fetchData(); }

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

    // KR01 : données brutes (ratio entrées/sorties)
    this.kr01Entries = this.krMap['KR01'] || [];
    // KR06 : ratio heures innovation (pourcentage)
    this.kr06Series = fill12('KR06');
  }

  private buildFallbackSeries() {
    const n = this.maxMonths;
    const M12 = ['Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc', 'Jan', 'Fév', 'Mar', 'Avr', 'Mai'];
    this.labels12 = M12.slice(0, n);
    this.kr01Entries = [];
    this.kr06Series = [3.2, 3.5, 4.1, 4.2, 4.8, 5.0, 4.5, 4.7, 4.9, 5.1, 5.2, 5.3].slice(0, n);
    this.kr02Detail = {
      hs: [4.2, 3.8, 5.1, 4.5, 3.9, 4.2, 3.5, 4.0, 4.3, 3.8, 4.1, 3.9].slice(0, n),
      vacances: [96, 88, 84, 78.4, 81.6, 76, 80, 78.4, 76, 73.6, 72, 70.4].slice(0, n),
      solde: [400, 390, 380, 370, 360, 350, 340, 330, 320, 310, 300, 290].slice(0, n),
    };
  }

  private generateMonthLabels(year: number): string[] {
    const short = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
    return short.map(m => `${m} ${year}`);
  }

  getLatestVal(krId: string): number | null {
    return this.latest[krId]?.actual_value ?? null;
  }

  getLatestStatus(krId: string): string {
    return this.latest[krId]?.status ?? 'unknown';
  }

  getLatestTarget(krId: string): number | null {
    return this.latest[krId]?.target_value ?? null;
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
    switch (status) { case 'green': return '▲'; case 'orange': return '⚠'; case 'red': return '▼'; default: return '—'; }
  }

  private renderCharts() {
    this.charts.forEach(c => c.destroy());
    this.charts = [];

    const C = {
      rh: '#AC4FC6', rh20: '#F0DCF7',
      co: '#00BB31', co20: '#D6F5DF',
      rd: '#E53935', gr: '#888888',
    };
    const n = this.labels12.length;

    // KR01 — Flux entrées/sorties (barre si données disponibles, sinon mock)
    const el01 = document.getElementById('rh-kr01') as HTMLCanvasElement | null;
    if (el01) {
      const hasData = this.kr01Entries.length > 0;
      // Reconstruct entries/exits from ratio if available — show ratio as line since we only have ratio in DB
      const ratioData: (number | null)[] = Array(Math.max(0, n)).fill(null);
      if (hasData) {
        this.kr01Entries.forEach(e => {
          const idx = e.period_month - 1;
          if (idx >= 0 && idx < n) ratioData[idx] = e.actual_value;
        });
      }
      this.charts.push(new Chart(el01.getContext('2d')!, {
        type: hasData ? 'line' : 'bar',
        data: {
          labels: this.labels12,
          datasets: hasData ? [
            { label: 'Ratio Entrées/Sorties', data: ratioData as any, borderColor: C.rh, backgroundColor: 'rgba(172, 79, 198, 0.08)', fill: true, tension: 0.3, borderWidth: 2 },
            { label: 'Équilibre (1.0)', data: Array(n).fill(1), borderColor: C.gr, borderDash: [5, 5], borderWidth: 1.5, fill: false, pointRadius: 0 },
          ] : [
            { label: 'Recrutements', data: [1, 0, 1, 2, 1, 1, 0, 1, 1, 1, 0, 1].slice(0, n), backgroundColor: C.rh },
            { label: 'Départs', data: [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0].slice(0, n), backgroundColor: C.rd },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } } }
      }));
    }

    // KR06 — Heures innovation
    const el06 = document.getElementById('rh-kr06') as HTMLCanvasElement | null;
    if (el06) {
      const target06 = this.krMap['KR06']?.[0]?.target_value ?? 5;
      this.charts.push(new Chart(el06.getContext('2d')!, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Innovation (%)', data: this.kr06Series as any, borderColor: C.co, borderWidth: 2, tension: 0.3, fill: false },
            { label: `Cible ${target06}%`, data: Array(n).fill(target06), borderColor: C.rd, borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } } }
      }));
    }

    // KR02 — Heures supp / vacances / solde (données réelles — kpi.okr_monthly, dimension detail)
    const el02 = document.getElementById('rh-kr02') as HTMLCanvasElement | null;
    if (el02) {
      this.charts.push(new Chart(el02.getContext('2d')!, {
        type: 'bar',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'HS (h)', data: this.kr02Detail.hs as any, backgroundColor: C.rh20, borderColor: C.rh, borderWidth: 1 },
            { label: 'Vacances prises (h)', data: this.kr02Detail.vacances as any, backgroundColor: C.co20, borderColor: C.co, borderWidth: 1 },
            { label: 'Solde vacances restant (h)', data: this.kr02Detail.solde as any, type: 'line', borderColor: '#3b82f6', borderWidth: 1.5, fill: false, pointRadius: 2, tension: 0.3 } as any,
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } } }
      }));
    }
  }
}
