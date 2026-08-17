import { Component, OnInit, AfterViewInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Chart, registerables, ScriptableContext } from 'chart.js';
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
  selector: 'app-ops-tab',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ops-tab.component.html',
})
export class OpsTabComponent implements OnInit, AfterViewInit, OnDestroy {
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
  kr10Series: (number | null)[] = [];
  kr18Series: (number | null)[] = [];
  kr22Series: (number | null)[] = [];
  kr25Series: (number | null)[] = [];
  kr26Series: (number | null)[] = [];
  kr27Series: (number | null)[] = [];
  kr19Series: (number | null)[] = [];

  // KR26 — Production/ETP par département (dimension department)
  kr26DeptRows: { dept: string; byMonth: Record<string, number | null>; avg: number | null }[] = [];
  kr26Months: string[] = [];

  ngOnInit() { this.fetchData(); }

  /** Montants monétaires (CHF) — paramétré centralement */
  money(val: number | null | undefined): string {
    return this.fmt.money(val);
  }

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
      const res = await fetch(`${environment.apiUrl}/api/okr/ops?annee=${this.activeYear}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      clearTimeout(safetyTimeout);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      this.krMap = json.kr_id_map || {};
      this.latest = json.latest || {};
      this.cdr.detectChanges();
      this.buildSeries();

      // KR26 — breakdown par département (dimension department)
      try {
        const controller2 = new AbortController();
        const t2 = setTimeout(() => controller2.abort(), 8000);
        const resDim = await fetch(`${environment.apiUrl}/api/okr/dimensions?annee=${this.activeYear}`, { signal: controller2.signal });
        clearTimeout(t2);
        if (resDim.ok) {
          const dim = await resDim.json();
          this.applyKr26(dim.dimensions?.['KR26']?.['department'] || {});
          this.cdr.detectChanges();
        }
      } catch (e2) {
        console.error('[ops-tab] dimensions', e2);
      }

      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    } catch (e) {
      clearTimeout(safetyTimeout);
      console.error('[ops-tab]', e);
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
    this.kr10Series = fill12('KR10'); // Incidents IT
    this.kr18Series = fill12('KR18'); // Projets déployés
    this.kr22Series = fill12('KR22'); // Facturation (%)
    this.kr25Series = fill12('KR25').map(v => v !== null ? v / 1000 : null); // Production cumulée (kCHF)
    this.kr26Series = fill12('KR26').map(v => v !== null ? v / 1000 : null); // Production moyenne (kCHF)
    this.kr27Series = fill12('KR27'); // Tâches ouvertes (%)
    this.kr19Series = fill12('KR19'); // Audits internes
  }

  /** KR26 — production/ETP par département, une ligne par dept (mois → kCHF) */
  private applyKr26(depts: Record<string, { period_key: string; period_month: number; actual_value: number | null }[]>) {
    const months = new Set<string>();
    const rows: { dept: string; byMonth: Record<string, number | null>; avg: number | null }[] = [];
    Object.entries(depts).forEach(([dept, entries]) => {
      const byMonth: Record<string, number | null> = {};
      (entries || []).forEach(e => {
        const k = e.period_key;
        months.add(k);
        byMonth[k] = e.actual_value !== null ? e.actual_value / 1000 : null;
      });
      const vals = Object.values(byMonth).filter((v): v is number => v !== null);
      const avg = vals.length ? Math.round(100 * vals.reduce((s, v) => s + v, 0) / vals.length) / 100 : null;
      rows.push({ dept, byMonth, avg });
    });
    rows.sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0));
    this.kr26DeptRows = rows;
    this.kr26Months = Array.from(months).sort();
  }

  private buildFallbackSeries() {
    const n = this.maxMonths;
    const M12 = ['Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc', 'Jan', 'Fév', 'Mar', 'Avr', 'Mai'];
    this.labels12 = M12.slice(0, n);
    this.kr10Series = [7, 5, 8, 4, 6, 5, 4, 6, 5, 4, 4, 4].slice(0, n);
    this.kr18Series = [3, 4, 3, 4, 3, 2, 4, 3, 4, 3, 4, 3].slice(0, n);
    this.kr22Series = [81, 82, 80, 83, 83, 84, 82, 83, 83, 84, 84, 84].slice(0, n);
    this.kr25Series = [120, 140, 150, 170, 180, 200, 210, 220, 230, 240, 250, 260].slice(0, n);
    this.kr26Series = [28, 29, 27, 30, 31, 28, 29, 30, 28, 29, 31, 30].slice(0, n);
    this.kr27Series = [25, 22, 20, 24, 19, 18, 21, 17, 18, 16, 15, 18].slice(0, n);
    this.kr19Series = [2, 1, 3, 2, 1, 4, 2, 1, 2, 1, 3, 1].slice(0, n);
    this.kr26DeptRows = [
      { dept: 'Tech & Dev', byMonth: { '2026-01': 34, '2026-02': 36, '2026-03': 33, '2026-04': 35, '2026-05': 36 }, avg: 34.8 },
      { dept: 'Commercial', byMonth: { '2026-01': 28, '2026-02': 29, '2026-03': 27, '2026-04': 30, '2026-05': 31 }, avg: 29.0 },
      { dept: 'Finance', byMonth: { '2026-01': 25, '2026-02': 26, '2026-03': 24, '2026-04': 27, '2026-05': 28 }, avg: 26.0 },
      { dept: 'Ops & IT', byMonth: { '2026-01': 30, '2026-02': 31, '2026-03': 29, '2026-04': 32, '2026-05': 33 }, avg: 31.0 },
      { dept: 'RH', byMonth: { '2026-01': 20, '2026-02': 21, '2026-03': 19, '2026-04': 22, '2026-05': 23 }, avg: 21.0 },
    ];
    this.kr26Months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
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
    switch (status) { case 'green': return 'b-ok'; case 'orange': return 'b-warn'; case 'red': return 'b-bad'; default: return ''; }
  }

  getStatusIcon(status: string): string {
    switch (status) { case 'green': return '▲'; case 'orange': return '⚠'; case 'red': return '▼'; default: return '—'; }
  }

  private renderCharts() {
    this.charts.forEach(c => c.destroy());
    this.charts = [];

    const C = {
      ops: '#00C7B1', ops20: '#CCF5F1',
      rd: '#E53935', rd20: '#FFE0E0',
      as: '#FF8F1C', as20: '#FFE9CC',
      gr: '#888888',
    };

    const target = (krId: string): number | null =>
      this.krMap[krId]?.[0]?.target_value ?? null;
    const n = this.labels12.length;

    // KR10 Incidents IT
    const el10 = document.getElementById('op-kr10') as HTMLCanvasElement | null;
    if (el10) {
      const limit = target('KR10') ?? 5;
      this.charts.push(new Chart(el10.getContext('2d')!, {
        type: 'bar',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Incidents IT', data: this.kr10Series as any, backgroundColor: (data: ScriptableContext<'bar'>) => (data.raw as number) > limit ? C.rd20 : C.ops20, borderColor: C.ops, borderWidth: 1 } as any,
            { label: `Seuil ${limit}`, data: Array(n).fill(limit), type: 'line', borderColor: C.rd, borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 } as any,
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } } }
      }));
    }

    // KR18 Projets déployés
    const el18 = document.getElementById('op-kr18') as HTMLCanvasElement | null;
    if (el18) {
      const objVal = target('KR18') ?? 4;
      this.charts.push(new Chart(el18.getContext('2d')!, {
        type: 'bar',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Projets déployés', data: this.kr18Series as any, backgroundColor: C.ops },
            { label: 'Objectif mensuel', data: Array(n).fill(objVal), type: 'line', borderColor: C.rd, borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 } as any,
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } } }
      }));
    }

    // KR19 Audits internes (données réelles — kpi.okr_monthly, KR19 via tâches 'audit')
    const el19 = document.getElementById('op-kr19') as HTMLCanvasElement | null;
    if (el19) {
      const t19 = target('KR19') ?? 4;
      const data19 = this.kr19Series.map(v => v ?? 0);
      this.charts.push(new Chart(el19.getContext('2d')!, {
        type: 'bar',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Audits internes', data: data19, backgroundColor: C.ops20, borderColor: C.ops, borderWidth: 1 } as any,
            { label: `Cible ${t19}/mois`, data: Array(n).fill(t19), type: 'line', borderColor: C.rd, borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 } as any,
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } } }
      }));
    }

    // KR25 Production cumulée
    const el25 = document.getElementById('op-kr25') as HTMLCanvasElement | null;
    if (el25) {
      const target25 = target('KR25') ? target('KR25')! / 1000 : 15;
      this.charts.push(new Chart(el25.getContext('2d')!, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Production (kCHF)', data: this.kr25Series as any, borderColor: C.ops, borderWidth: 2, tension: 0.3, fill: false },
            { label: `Cible ${target25}k/ETP`, data: Array(n).fill(target25), borderColor: C.rd, borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } } }
      }));
    }

    // KR26 Production moyenne par département (données réelles — dimension department)
    const el26 = document.getElementById('op-kr26') as HTMLCanvasElement | null;
    if (el26) {
      const lastMonth = this.kr26Months.length ? this.kr26Months[this.kr26Months.length - 1] : '';
      const labels = this.kr26DeptRows.length
        ? this.kr26DeptRows.map(d => d.dept)
        : ['Aucune donnée'];
      const latest = this.kr26DeptRows.length
        ? this.kr26DeptRows.map(d => d.byMonth[lastMonth] ?? d.avg ?? 0)
        : [0];
      const avgLatest = this.kr26DeptRows.length
        ? this.kr26DeptRows.reduce((s, d) => s + (d.byMonth[lastMonth] ?? d.avg ?? 0), 0) / this.kr26DeptRows.length
        : 0;
      this.charts.push(new Chart(el26.getContext('2d')!, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: `${lastMonth ? lastMonth.slice(0, 7) : 'Dernier mois'} (kCHF/ETP)`, data: latest, backgroundColor: ['#3b82f6', '#d946ef', '#eab308', '#14b8a6', '#f97316', '#00C7B1'] },
            { label: 'Moyenne départements', data: Array(labels.length).fill(avgLatest), type: 'line', borderColor: '#888', borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 } as any,
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } },
          scales: { y: { min: 0, ticks: { callback: (v: any) => v + 'k' } } }
        }
      }));
    }

    // KR27 — % de tâches ouvertes (données réelles — kpi.okr_monthly, KR27)
    const el27 = document.getElementById('op-kr27') as HTMLCanvasElement | null;
    if (el27) {
      const t27 = target('KR27') ?? 20;
      this.charts.push(new Chart(el27.getContext('2d')!, {
        type: 'bar',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Tâches ouvertes (%)', data: this.kr27Series as any, backgroundColor: C.ops20, borderColor: C.ops, borderWidth: 1 } as any,
            { label: `Cible ${t27}%`, data: Array(n).fill(t27), type: 'line', borderColor: C.rd, borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 } as any,
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } }, scales: { y: { min: 0, max: 100, ticks: { callback: (v: any) => v + '%' } } } }
      }));
    }

    // KR22 Taux de facturation
    const el22 = document.getElementById('op-kr22') as HTMLCanvasElement | null;
    if (el22) {
      const t22 = target('KR22') ?? 90;
      this.charts.push(new Chart(el22.getContext('2d')!, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Facturation (%)', data: this.kr22Series as any, borderColor: C.ops, borderWidth: 2, tension: 0.3, fill: false },
            { label: `Cible ${t22}%`, data: Array(n).fill(t22), borderColor: C.rd, borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } }, scales: { y: { min: 0, max: 100 } } }
      }));
    }
  }
}
