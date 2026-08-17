import { Component, OnInit, AfterViewInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { environment } from '../../../environments/environment';
import { FormatService } from '../../shared/format.service';

Chart.register(...registerables);

interface SyntheseResponse {
  annee: number;
  labels: number[];
  kr15: { series: (number | null)[]; latest: number | null };
  kr11: { series: (number | null)[]; target: number; latest: number | null; status: string };
  kr22: { series: (number | null)[]; latest: number | null };
  kpis: Record<string, { value: number | null; target: number | null; status: string }>;
}

interface OkrEntry {
  period_key: string;
  period_month: number;
  actual_value: number | null;
  target_value: number | null;
  status: string;
}

interface OpsResponse {
  annee: number;
  kr_id_map: Record<string, OkrEntry[]>;
}

@Component({
  selector: 'app-dashboard-tab',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard-tab.component.html',
})
export class DashboardTabComponent implements OnInit, AfterViewInit, OnDestroy {
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

  // Séries réelles (kCHF)
  labels12: string[] = [];
  caSeries: (number | null)[] = [];
  tresSeries: (number | null)[] = [];
  tresTarget = 500;
  billingSeries: (number | null)[] = [];
  prodSeries: (number | null)[] = [];

  caLatest: number | null = null;
  tresLatest: number | null = null;

  /** Cartes KPI (KR07, KR22, KR16, KR10, KR13, KR18) depuis /api/dashboard/synthese */
  kpis: SyntheseResponse['kpis'] = {};

  ngOnInit() {
    this.fetchData();
  }

  ngAfterViewInit() {
    this.viewReady = true;
    if (this.dataReady) this.renderCharts();
  }

  ngOnDestroy() {
    this.charts.forEach(c => c.destroy());
  }

  async fetchData() {
    this.loading = true;
    this.error = false;
    this.charts.forEach(c => c.destroy());
    this.charts = [];

    const safetyTimeout = setTimeout(() => {
      this.loading = false;
      this.error = true;
      this.buildFallback();
      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    }, 10000);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const [syntRes, opsRes] = await Promise.all([
        fetch(`${environment.apiUrl}/api/dashboard/synthese?annee=${this.activeYear}`, { signal: controller.signal }),
        fetch(`${environment.apiUrl}/api/okr/ops?annee=${this.activeYear}`, { signal: controller.signal }),
      ]);
      clearTimeout(timeoutId);
      clearTimeout(safetyTimeout);
      if (!syntRes.ok || !opsRes.ok) throw new Error('HTTP ' + syntRes.status);

      const json: SyntheseResponse = await syntRes.json();
      const opsJson: OpsResponse = await opsRes.json();

      const short = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
      const n = this.maxMonths;
      this.labels12 = short.slice(0, n).map(m => `${m} ${json.annee}`);
      this.caSeries = json.kr15.series.slice(0, n);
      this.tresSeries = json.kr11.series.slice(0, n);
      this.tresTarget = json.kr11.target;
      this.billingSeries = json.kr22.series.slice(0, n);
      this.caLatest = json.kr15.latest;
      this.tresLatest = json.kr11.latest;
      this.kpis = json.kpis;

      // KR25 — production mensuelle (kCHF) depuis /api/okr/ops
      const kr25 = opsJson.kr_id_map?.['KR25'] ?? [];
      this.prodSeries = Array(n).fill(null);
      kr25.forEach(e => {
        const i = e.period_month - 1;
        if (i >= 0 && i < n && e.actual_value !== null) {
          this.prodSeries[i] = e.actual_value / 1000;
        }
      });

      this.cdr.detectChanges();
      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    } catch (e) {
      clearTimeout(safetyTimeout);
      console.error('[dashboard-tab]', e);
      this.error = true;
      this.buildFallback();
      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    } finally {
      this.loading = false;
    }
  }

  onYearChange() { this.fetchData(); }

  /** Valeurs statiques de secours si l'API est indisponible */
  private buildFallback() {
    const n = this.maxMonths;
    const M12 = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
    this.labels12 = M12.slice(0, n).map(m => `${m} ${this.activeYear}`);
    this.caSeries = [90, 103, 292, 435, 339, 178, null, null, null, null, null, null].slice(0, n);
    this.tresSeries = [980, 1050, 920, 1100, 1180, 1250, 1080, 1150, 1200, 1220, 1240, 1240].slice(0, n);
    this.tresTarget = 500;
    this.billingSeries = [81, 82, 80, 83, 82, 84, 81, 83, 83, 84, 84, 84].slice(0, n);
    this.prodSeries = [42, 45, 41, 48, 50, 52, 44, 49, 51, 53, 54, 56].slice(0, n);
    this.caLatest = 339;
    this.tresLatest = 1240;
    this.kpis = {
      KR07: { value: 47, target: 7, status: 'ok' },
      KR22: { value: 84, target: 90, status: 'warn' },
      KR16: { value: 28, target: 20, status: 'ok' },
      KR10: { value: 4, target: 5, status: 'ok' },
      KR13: { value: 2.3, target: 0, status: 'warn' },
      KR18: { value: 17, target: null, status: 'ok' },
    };
  }

  formatK(val: number | null): string {
    return this.fmt.money(val);
  }

  kpiVal(krId: string): number | null {
    const k = this.kpis[krId];
    return k && k.value !== null && k.value !== undefined ? k.value : null;
  }

  kpiTarget(krId: string): number | null {
    const k = this.kpis[krId];
    return k && k.target !== null && k.target !== undefined ? k.target : null;
  }

  kpiFmt(krId: string, unit: string, decimals = 0, signed = false): string {
    const v = this.kpiVal(krId);
    if (v === null) return '—';
    const sign = signed && v > 0 ? '+' : '';
    return `${sign}${v.toFixed(decimals)}${unit}`;
  }

  kpiTargetLabel(krId: string, unit: string): string {
    const t = this.kpiTarget(krId);
    return t === null ? '—' : `${t}${unit}`;
  }

  private renderCharts() {
    this.charts.forEach(c => c.destroy());
    this.charts = [];

    const C = {
      fi: '#0047BB', fi20: '#D6E4F7',
      co: '#00BB31', co20: '#D6F5DF',
      rh: '#AC4FC6', rh20: '#F0DCF7',
      ops: '#00C7B1', ops20: '#CCF5F1',
      rd: '#E53935', gr: '#888888',
    };
    const n = this.labels12.length;

    // CA mensuel (données réelles : kpi.okr_monthly, KR15)
    const dCaCtx = (document.getElementById('d-ca') as HTMLCanvasElement)?.getContext('2d');
    if (dCaCtx) {
      this.charts.push(new Chart(dCaCtx, {
        type: 'bar',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Réalisé (kCHF)', data: this.caSeries as any, backgroundColor: C.fi },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } }, scales: { y: { min: 0 } } }
      }));
    }

    // Trésorerie mensuelle (données réelles : kpi.okr_monthly, KR11)
    const dTresCtx = (document.getElementById('d-tres') as HTMLCanvasElement)?.getContext('2d');
    if (dTresCtx) {
      this.charts.push(new Chart(dTresCtx, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Trésorerie (kCHF)', data: this.tresSeries as any, borderColor: C.ops, backgroundColor: C.ops20 + '66', fill: true, tension: 0.3, borderWidth: 2 },
            { label: `Seuil ${this.tresTarget}k`, data: Array(n).fill(this.tresTarget), borderColor: C.rd, borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } } }
      }));
    }

    // Production mensuelle — KR25 (données réelles : kpi.okr_monthly via /api/okr/ops)
    const dProdCtx = (document.getElementById('d-prod') as HTMLCanvasElement)?.getContext('2d');
    if (dProdCtx) {
      this.charts.push(new Chart(dProdCtx, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Production (kCHF)', data: this.prodSeries as any, borderColor: '#7B3F00', backgroundColor: 'rgba(123, 63, 0, 0.08)', fill: true, tension: 0.3, borderWidth: 2 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } }, scales: { y: { min: 0 } } }
      }));
    }

    // Taux de facturation — KR22 (données réelles : kpi.okr_monthly via synthèse)
    const dFactCtx = (document.getElementById('d-fact') as HTMLCanvasElement)?.getContext('2d');
    if (dFactCtx) {
      const target = this.kpiTarget('KR22') ?? 90;
      this.charts.push(new Chart(dFactCtx, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Facturation (%)', data: this.billingSeries as any, borderColor: C.rh, backgroundColor: 'rgba(172, 79, 198, 0.08)', fill: true, tension: 0.3, borderWidth: 2 },
            { label: `Cible ${target}%`, data: Array(n).fill(target), borderColor: '#22c55e', borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } }, scales: { y: { min: 75, max: 95 } } }
      }));
    }
  }
}
