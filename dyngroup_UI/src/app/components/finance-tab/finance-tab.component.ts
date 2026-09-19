import { Component, OnInit, AfterViewInit, OnDestroy, ChangeDetectorRef, ElementRef, ViewChild, HostListener } from '@angular/core';
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
  ca?: number | null;
}

interface CompanyRow {
  id: number;
  name: string;
  level: number;
}

@Component({
  selector: 'app-finance-tab',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './finance-tab.component.html',
  styleUrl: './finance-tab.component.css',
})
export class FinanceTabComponent implements OnInit, AfterViewInit, OnDestroy {
  private charts: Chart[] = [];
  private viewReady = false;
  private dataReady = false;

  loading = true;
  error = false;

  // Filtre société (multi-sélection, hiérarchique — façon Odoo Accounting > Reporting).
  // Tableau vide = "toutes les sociétés", même convention que le dashboard Opérationnel.
  companiesTree: CompanyRow[] = [];
  activeCompanies: number[] = [];
  companyFilterOpen = false;
  @ViewChild('companyFilterContainer') companyFilterContainerRef?: ElementRef<HTMLElement>;

  // Filtre période — par défaut année civile en cours. Sans effet sur KR20/KR24
  // (photos "à l'instant présent", voir docs/finance.md).
  dateFrom: string;
  dateTo: string;

  constructor(private fmt: FormatService, private cdr: ChangeDetectorRef) {
    const now = new Date();
    this.dateFrom = `${now.getFullYear()}-01-01`;
    this.dateTo = now.toISOString().slice(0, 10);
  }

  // Données chargées depuis l'API
  krMap: Record<string, OkrEntry[]> = {};
  latest: Record<string, OkrEntry> = {};

  // Données calculées pour les charts
  labels12: string[] = [];
  kr15Series: (number | null)[] = [];
  kr14Series: (number | null)[] = [];
  kr11Series: (number | null)[] = [];
  kr13Series: (number | null)[] = [];
  kr15TargetSeries: (number | null)[] = [];

  // KR24 — Ancienneté TEC (tranches d'âge, montant en kCHF)
  kr24Buckets: { label: string; kchf: number }[] = [];
  kr24Avg: number | null = null;

  ngOnInit() {
    this.fetchCompanies();
    this.fetchData();
  }

  ngAfterViewInit() {
    this.viewReady = true;
    if (this.dataReady) this.renderCharts();
  }

  ngOnDestroy() { this.charts.forEach(c => c.destroy()); }

  async fetchCompanies() {
    try {
      const res = await fetch(`${environment.apiUrl}/api/finance/companies`);
      if (res.ok) {
        const json = await res.json();
        this.companiesTree = Array.isArray(json.companies) ? json.companies : [];
      }
    } catch (e) {
      console.error('[finance-tab] companies', e);
    }
  }

  async fetchData() {
    this.loading = true;
    this.error = false;
    this.charts.forEach(c => c.destroy());
    this.charts = [];

    const safetyTimeout = setTimeout(() => {
      this.loading = false;
      this.error = true;
      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    }, 10000);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const params = new URLSearchParams({ date_from: this.dateFrom, date_to: this.dateTo });
      if (this.activeCompanies.length) params.set('companies', this.activeCompanies.join(','));
      const res = await fetch(`${environment.apiUrl}/api/finance/dashboard?${params.toString()}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      clearTimeout(safetyTimeout);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      this.krMap = json.kr_id_map || {};
      this.latest = json.latest || {};
      this.kr24Buckets = (json.kr24Buckets || []).map((b: any) => ({ label: b.label, kchf: (b.amount || 0) / 1000 }));
      this.kr24Avg = this.latest['KR24']?.actual_value ?? null;
      this.cdr.detectChanges();
      this.buildSeries();

      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    } catch (e) {
      clearTimeout(safetyTimeout);
      console.error('[finance-tab]', e);
      this.error = true;
      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    } finally {
      this.loading = false;
    }
  }

  onFiltersChange() { this.fetchData(); }

  /** Coche/décoche une société dans le filtre multi-sélection. */
  toggleCompany(id: number) {
    const idx = this.activeCompanies.indexOf(id);
    if (idx >= 0) this.activeCompanies.splice(idx, 1);
    else this.activeCompanies.push(id);
    this.onFiltersChange();
  }

  isCompanySelected(id: number): boolean {
    return this.activeCompanies.includes(id);
  }

  /** Vide la sélection de sociétés ("toutes les sociétés"). */
  clearCompanies() {
    if (this.activeCompanies.length === 0) return;
    this.activeCompanies = [];
    this.onFiltersChange();
  }

  /** Libellé affiché sur le bouton du filtre Société (résumé de la sélection). */
  get companyFilterLabel(): string {
    if (this.activeCompanies.length === 0) return 'Toutes les sociétés';
    if (this.activeCompanies.length === 1) {
      return this.companiesTree.find(c => c.id === this.activeCompanies[0])?.name || '1 société';
    }
    return `${this.activeCompanies.length} sociétés`;
  }

  /** Ferme le filtre Société au clic en dehors de son conteneur. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.companyFilterOpen
        && this.companyFilterContainerRef
        && !this.companyFilterContainerRef.nativeElement.contains(event.target as Node)) {
      this.companyFilterOpen = false;
    }
  }

  /** Liste des mois (YYYY-MM) couverts par la plage de dates sélectionnée. */
  private monthsInRange(from: string, to: string): string[] {
    const out: string[] = [];
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    let y = fy, m = fm;
    while (y < ty || (y === ty && m <= tm)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  /** Construit les séries pour les charts à partir des period_key retournés par l'API
   *  (et non plus d'un index period_month fixé à une année unique — la plage de dates
   *  peut désormais couvrir plusieurs années). */
  private buildSeries() {
    this.labels12 = this.monthsInRange(this.dateFrom, this.dateTo);
    const fillFromKey = (krId: string, divisor = 1): (number | null)[] => {
      const byKey = new Map((this.krMap[krId] || []).map(e => [e.period_key, e.actual_value]));
      return this.labels12.map(key => {
        const v = byKey.get(key);
        return v !== undefined && v !== null ? v / divisor : null;
      });
    };
    this.kr15Series = fillFromKey('KR15', 1000); // kCHF
    this.kr14Series = fillFromKey('KR14', 1000);
    this.kr11Series = fillFromKey('KR11', 1000);
    this.kr13Series = fillFromKey('KR13'); // % de dépassement (déjà en %)

    // Budget CA réel par mois (staging.account_report_budget_item) — remplace la ligne plate
    // qu'on utilisait faute de budget saisi dans Odoo.
    const byKey15 = new Map((this.krMap['KR15'] || []).map(e => [e.period_key, e.target_value]));
    this.kr15TargetSeries = this.labels12.map(key => {
      const t = byKey15.get(key);
      return t !== undefined && t !== null ? t / 1000 : null;
    });
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

    // KR15 CA mensuel (bar)
    const el15 = document.getElementById('fi-kr15') as HTMLCanvasElement | null;
    if (el15) {
      // Budget CA réel par mois (staging.account_report_budget_item), null si aucun budget
      // saisi pour ce mois précis — pas de valeur arbitraire de repli.
      const targetSeries15 = this.kr15TargetSeries;
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

    // KR20 DSO — photo à l'instant présent (pas de série mensuelle, voir docs/finance.md) :
    // simple comparaison Actuel vs Cible.
    const el2021 = document.getElementById('fi-kr2021') as HTMLCanvasElement | null;
    if (el2021) {
      const dsoTarget = 45; // cible fixe KR20 (kpi_config.py)
      const dsoVal = this.getLatestVal('KR20');
      this.charts.push(new Chart(el2021.getContext('2d')!, {
        type: 'bar',
        data: {
          labels: ['DSO actuel', 'Cible'],
          datasets: [{ label: 'Jours', data: [dsoVal, dsoTarget], backgroundColor: [C.dso, C.gr] }]
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { min: 0, ticks: { callback: (v: any) => v + 'j' } } }
        }
      }));
    }

    // KR13 Dépassement budget frais fixes
    const el13 = document.getElementById('fi-kr13') as HTMLCanvasElement | null;
    if (el13) {
      const couleur = (v: number | null) =>
        v === null ? C.gr : v >= 10 ? C.rd : v >= 5 ? '#f97316' : '#22c55e';
      this.charts.push(new Chart(el13.getContext('2d')!, {
        type: 'bar',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Écart vs budget (%)', data: this.kr13Series as any,
              backgroundColor: this.kr13Series.map(couleur) },
            { label: 'Budget (0%)', data: Array(n).fill(0), type: 'line',
              borderColor: C.gr, borderDash: [6, 4], borderWidth: 1.5,
              fill: false, pointRadius: 0 } as any,
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } },
          scales: { y: { ticks: { callback: (v: any) => v + '%' } } }
        }
      }));
    }

    // KR24 TEC Aging (tranches d'ancienneté, photo à l'instant présent)
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
