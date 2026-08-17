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
  selector: 'app-commercial-tab',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './commercial-tab.component.html',
})
export class CommercialTabComponent implements OnInit, AfterViewInit, OnDestroy {
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
  kr07Series: (number | null)[] = [];
  kr16Series: (number | null)[] = [];
  kr09Series: (number | null)[] = [];
  kr17Series: (number | null)[] = [];

  // KR04 — Engagement digital par réseau (données réelles)
  kr04Networks: Record<string, (number | null)[]> = {};
  kr04NetworksList: string[] = [];

  // KR05 — Avis Google (données réelles)
  kr05RatingSeries: (number | null)[] = [];
  kr05CountSeries: (number | null)[] = [];
  kr05LatestRating: number | null = null;
  kr05TotalReviews = 0;
  kr05HasData = false;
  kr05Distribution: { rating: number; nb: number }[] = [];
  kr05Reviews: { rating: number; author: string; text: string; date: string | null }[] = [];

  // Infobulle avis Google (survol)
  tipVisible = false;
  tipX = 0;
  tipY = 0;
  tipTitle = '';
  tipList: { rating: number; author: string; text: string }[] = [];
  tipRandom: { rating: number; author: string; text: string } | null = null;

  // KR08 — Mouvement clients (dimension detail : total / acquisitions / pertes)
  kr08Net: (number | null)[] = [];
  kr08Detail: { total: (number | null)[]; acquisitions: (number | null)[]; pertes: (number | null)[] } = {
    total: [], acquisitions: [], pertes: [],
  };

  // KR23 — Top 10 clients (dimension client, dernier mois disponible)
  kr23Clients: { name: string; pct: number; cum: number }[] = [];

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

    // Safety timeout - force loading=false after 10s no matter what
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
      const res = await fetch(`${environment.apiUrl}/api/okr/commercial?annee=${this.activeYear}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      clearTimeout(safetyTimeout);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      this.krMap = json.kr_id_map || {};
      this.latest = json.latest || {};
      this.cdr.detectChanges();
      this.buildSeries();

      // KR04 engagement digital par réseau (endpoint dédié)
      try {
        const controller2 = new AbortController();
        const t2 = setTimeout(() => controller2.abort(), 8000);
        const resEng = await fetch(`${environment.apiUrl}/api/dashboard/engagement?annee=${this.activeYear}`, { signal: controller2.signal });
        clearTimeout(t2);
        if (resEng.ok) {
          const eng = await resEng.json();
          this.kr04Networks = eng.networks || {};
          this.kr04NetworksList = Object.keys(this.kr04Networks);
        }
      } catch (e2) {
        console.error('[commercial-tab] engagement', e2);
      }

      // KR05 avis Google (endpoint dédié)
      try {
        const controller3 = new AbortController();
        const t3 = setTimeout(() => controller3.abort(), 8000);
        const resRev = await fetch(`${environment.apiUrl}/api/dashboard/google-reviews?annee=${this.activeYear}`, { signal: controller3.signal });
        clearTimeout(t3);
        if (resRev.ok) {
          const rev = await resRev.json();
          this.kr05RatingSeries = rev.ratingSeries || Array(12).fill(null);
          this.kr05CountSeries = rev.countSeries || Array(12).fill(null);
          this.kr05LatestRating = rev.latestRating ?? null;
          this.kr05TotalReviews = rev.totalReviews ?? 0;
          this.kr05HasData = !!rev.hasData;
          this.kr05Distribution = rev.distribution || [];
          this.kr05Reviews = rev.reviews || [];
          this.cdr.detectChanges();
        }
      } catch (e3) {
        console.error('[commercial-tab] google-reviews', e3);
      }

      // Dimensions détaillées (KR08 par détail, KR23 par client)
      try {
        const controller4 = new AbortController();
        const t4 = setTimeout(() => controller4.abort(), 8000);
        const resDim = await fetch(`${environment.apiUrl}/api/okr/dimensions?annee=${this.activeYear}`, { signal: controller4.signal });
        clearTimeout(t4);
        if (resDim.ok) {
          const dim = await resDim.json();
          const n = this.maxMonths;
          this.applyKr08Detail(dim.dimensions?.['KR08']?.['detail'] || {}, n);
          this.applyKr23Clients(dim.dimensions?.['KR23']?.['client'] || {});
          this.cdr.detectChanges();
        }
      } catch (e4) {
        console.error('[commercial-tab] dimensions', e4);
      }

      this.dataReady = true;
      if (this.viewReady) setTimeout(() => this.renderCharts(), 0);
    } catch (e) {
      clearTimeout(safetyTimeout);
      console.error('[commercial-tab]', e);
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
    this.kr07Series = fill12('KR07');   // NPS proxy score
    this.kr16Series = fill12('KR16');   // Leads reçus (nombre)
    this.kr09Series = fill12('KR09');   // Panier moyen CHF
    this.kr17Series = fill12('KR17');   // Leads traités %
    this.kr08Net = fill12('KR08');      // Mouvement net clients vs M-1
  }

  /** Séries de la dimension detail de KR08 (total / acquisitions / pertes) */
  private applyKr08Detail(detail: Record<string, { period_month: number; actual_value: number | null }[]>, n: number) {
    const series = (key: string): (number | null)[] => {
      const arr: (number | null)[] = Array(n).fill(null);
      (detail[key] || []).forEach(e => {
        const idx = e.period_month - 1;
        if (idx >= 0 && idx < n) arr[idx] = e.actual_value;
      });
      return arr;
    };
    this.kr08Detail = {
      total: series('total'),
      acquisitions: series('acquisitions'),
      pertes: series('pertes'),
    };
  }

  /** Top 10 clients KR23 — dernier mois disponible (dimension client) */
  private applyKr23Clients(clients: Record<string, { period_month: number; actual_value: number | null }[]>) {
    const rows: { name: string; pct: number; month: number }[] = [];
    Object.entries(clients).forEach(([name, entries]) => {
      if (!entries.length) return;
      let best = entries[0];
      entries.forEach(e => { if (e.period_month > best.period_month) best = e; });
      if (best.actual_value !== null) rows.push({ name, pct: best.actual_value, month: best.period_month });
    });
    rows.sort((a, b) => b.pct - a.pct);
    const top10 = rows.slice(0, 10);
    let cum = 0;
    this.kr23Clients = top10.map(r => { cum += r.pct; return { name: r.name, pct: r.pct, cum: Math.round(cum * 100) / 100 }; });
  }

  private buildFallbackSeries() {
    const n = this.maxMonths;
    const M12 = ['Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc', 'Jan', 'Fév', 'Mar', 'Avr', 'Mai'];
    this.labels12 = M12.slice(0, n);
    this.kr07Series = [28, 31, 30, 33, 35, 37, 38, 40, 42, 43, 45, 47].slice(0, n);
    this.kr16Series = [15, 18, 12, 20, 22, 24, 18, 21, 23, 25, 26, 28].slice(0, n);
    this.kr09Series = [1720, 1740, 1750, 1770, 1780, 1800, 1790, 1810, 1830, 1810, 1840, 1870].slice(0, n);
    this.kr17Series = [75, 80, 72, 82, 85, 88, 79, 84, 86, 87, 89, 100].slice(0, n);
    this.kr04Networks = {
      facebook: [3800, 3900, 4200, 4400, 4600, 4700, 4400, 4700, 4900, 4820, 5110, 5380].slice(0, n),
      linkedin: [9000, 9500, 10200, 10800, 11200, 11500, 11000, 11800, 12500, 12400, 13200, 14100].slice(0, n),
      instagram: [2800, 2900, 3000, 3100, 3200, 3300, 3100, 3150, 3200, 3200, 3150, 3400].slice(0, n),
    };
    this.kr04NetworksList = Object.keys(this.kr04Networks);
    this.kr05RatingSeries = [4.5, 4.6, 4.6, 4.7, 4.6, 4.6, 4.7, 4.7, 4.6, 4.6, 4.6, 4.6].slice(0, n);
    this.kr05CountSeries = [18, 22, 20, 25, 24, 28, 26, 30, 27, 29, 31, 33].slice(0, n);
    this.kr05LatestRating = 4.6;
    this.kr05TotalReviews = 312;
    this.kr05HasData = true;
    this.kr05Distribution = [
      { rating: 5, nb: 243 }, { rating: 4, nb: 47 }, { rating: 3, nb: 16 },
      { rating: 2, nb: 4 }, { rating: 1, nb: 2 },
    ];
    this.kr08Net = [2, 2, 2, 2, 2, 2, 3, 2, 3, 2, 3, 1].slice(0, n);
    this.kr08Detail = {
      total: [230, 232, 234, 236, 238, 240, 238, 241, 243, 240, 244, 245].slice(0, n),
      acquisitions: [3, 4, 3, 4, 5, 4, 5, 4, 4, 4, 5, 3].slice(0, n),
      pertes: [-1, -2, -1, -2, -3, -2, -2, -2, -1, -2, -1, -2].slice(0, n),
    };
    this.kr23Clients = [
      { name: 'Helvetia SA', pct: 11.2, cum: 11.2 }, { name: 'SwissRe', pct: 9.3, cum: 20.5 },
      { name: 'Zurich Insurance', pct: 7.5, cum: 28.0 }, { name: 'Novartis', pct: 6.9, cum: 34.9 },
      { name: 'Nestlé', pct: 6.0, cum: 40.9 }, { name: 'ABB', pct: 5.0, cum: 45.9 },
      { name: 'Roche', pct: 4.6, cum: 50.5 }, { name: 'UBS', pct: 4.0, cum: 54.5 },
      { name: 'SGS', pct: 3.5, cum: 58.0 }, { name: 'Swatch', pct: 3.0, cum: 61.0 },
    ];
  }

  private generateMonthLabels(year: number): string[] {
    const short = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
    return short.map(m => `${m} ${year}`);
  }

  getLatestVal(krId: string): number | null {
    return this.latest[krId]?.actual_value ?? null;
  }

  getTargetVal(krId: string): number | null {
    return this.latest[krId]?.target_value ?? null;
  }

  /** Distribution des étoiles (1..5) en % — source staging.rating_rating */
  get starDist(): { rating: number; nb: number; pct: number }[] {
    const total = this.kr05Distribution.reduce((s, d) => s + d.nb, 0);
    if (!total) return [];
    return this.kr05Distribution.map(d => ({
      rating: d.rating,
      nb: d.nb,
      pct: Math.round(1000 * d.nb / total) / 10,
    }));
  }

  /** Survol d'une note (5★, 4★…) : avis correspondants + 1 avis aléatoire de cette note */
  onStarHover(rating: number, ev: MouseEvent) {
    const all = this.kr05Reviews.filter(r => r.rating === rating);
    if (!all.length) {
      this.hideTip();
      return;
    }
    this.tipTitle = `Avis ${rating} ★ (${all.length})`;
    this.tipList = all.slice(0, 4).map(r => ({ rating: r.rating, author: r.author, text: this.short(r.text) }));
    this.tipRandom = { rating: all[0].rating, author: all[0].author, text: this.short(all[0].text) };
    this.tipVisible = true;
    this.moveTip(ev);
  }

  /** Survol de la note globale : 1 avis aléatoire parmi tous */
  onRatingHover(ev: MouseEvent) {
    if (!this.kr05Reviews.length) { this.hideTip(); return; }
    const r = this.kr05Reviews[Math.floor(Math.random() * this.kr05Reviews.length)];
    this.tipTitle = 'Avis au hasard';
    this.tipList = [];
    this.tipRandom = { rating: r.rating, author: r.author, text: this.short(r.text) };
    this.tipVisible = true;
    this.moveTip(ev);
  }

  moveTip(ev: MouseEvent) {
    this.tipX = ev.clientX + 16;
    this.tipY = ev.clientY + 14;
  }

  hideTip() {
    this.tipVisible = false;
    this.tipList = [];
    this.tipRandom = null;
  }

  private short(text: string, max = 180): string {
    if (!text) return '(avis sans commentaire)';
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  getLatestStatus(krId: string): string {
    return this.latest[krId]?.status ?? 'unknown';
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
      fi: '#0047BB', fi20: '#D6E4F7',
      co: '#22c55e', co20: '#D6F5DF',
      rd: '#ef4444', rd20: '#FFE0E0',
      as: '#FF8F1C', as20: '#FFE9CC',
      gr: '#888888',
    };

    const target = (krId: string): number | null =>
      this.krMap[krId]?.[0]?.target_value ?? null;
    const n = this.labels12.length;

    // KR07 NPS Evolution
    const el07 = document.getElementById('co-kr07') as HTMLCanvasElement | null;
    if (el07) {
      const t07 = target('KR07') ?? 40;
      this.charts.push(new Chart(el07.getContext('2d')!, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'NPS proxy', data: this.kr07Series as any, borderColor: C.co, backgroundColor: 'rgba(34, 197, 94, 0.08)', fill: true, tension: 0.3, borderWidth: 2 },
            { label: `Cible ${t07}`, data: Array(n).fill(t07), borderColor: C.rd, borderDash: [6, 4], borderWidth: 1.5, fill: false, pointRadius: 0 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0 } } }
      }));
    }

    // KR16 Leads reçus
    const el16 = document.getElementById('co-kr16') as HTMLCanvasElement | null;
    if (el16) {
      const t16 = target('KR16') ?? 20;
      const leadsData = this.kr16Series.map(v => v ?? 0);
      this.charts.push(new Chart(el16.getContext('2d')!, {
        type: 'bar',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Leads reçus', data: leadsData as any, backgroundColor: leadsData.map(v => v >= t16 ? C.co : 'rgba(34, 197, 94, 0.25)'), borderColor: C.co, borderWidth: 1 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
      }));
    }

    // KR04 Engagement digital par réseau (données réelles — kpi.okr_monthly, KR04)
    const el04 = document.getElementById('co-kr04') as HTMLCanvasElement | null;
    if (el04) {
      const palette: Record<string, string> = {
        facebook: '#3b82f6', linkedin: '#d946ef', instagram: '#f97316',
        twitter: '#1da1f2', youtube: '#ef4444', odoo_social: '#8761ff',
        website: '#00C7B1', unknown: '#888888',
      };
      const datasets = this.kr04NetworksList.map((net) => ({
        label: net.charAt(0).toUpperCase() + net.slice(1),
        data: this.kr04Networks[net] as any,
        borderColor: palette[net] || '#888888',
        backgroundColor: (palette[net] || '#888888') + '22',
        tension: 0.3, borderWidth: 2, fill: false,
      }));
      if (datasets.length === 0) {
        datasets.push({ label: 'Aucune donnée', data: Array(n).fill(null), borderColor: '#888888', backgroundColor: '#88888822', tension: 0.3, borderWidth: 2, fill: false });
      }
      this.charts.push(new Chart(el04.getContext('2d')!, {
        type: 'line',
        data: { labels: this.labels12, datasets },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } } }
      }));
    }

    // KR08 Mouvement clients vs M-1 (données réelles — kpi.okr_monthly, KR08 + dimension detail)
    const el08 = document.getElementById('co-kr08') as HTMLCanvasElement | null;
    if (el08) {
      this.charts.push(new Chart(el08.getContext('2d')!, {
        type: 'bar',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Acquisitions', data: this.kr08Detail.acquisitions as any, backgroundColor: C.co, stack: 's' },
            { label: 'Pertes', data: this.kr08Detail.pertes as any, backgroundColor: C.rd, stack: 's' },
            { label: 'Solde net', data: this.kr08Net as any, type: 'line', borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.10)', tension: 0.3, borderWidth: 2, fill: true, pointRadius: 2 } as any,
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } }, scales: { y: { min: 0 } } }
      }));
    }

    // KR09 Panier moyen
    const el09 = document.getElementById('co-kr09') as HTMLCanvasElement | null;
    if (el09) {
      const t09 = target('KR09') ?? 5000;
      this.charts.push(new Chart(el09.getContext('2d')!, {
        type: 'line',
        data: {
          labels: this.labels12,
          datasets: [
            { label: 'Panier moyen (CHF)', data: this.kr09Series as any, borderColor: C.co, backgroundColor: 'rgba(34, 197, 94, 0.08)', fill: true, tension: 0.3, borderWidth: 2 },
            { label: `Budget ${this.fmt.money(t09)}`, data: Array(n).fill(t09), borderColor: C.gr, borderDash: [5, 5], borderWidth: 1.5, fill: false, pointRadius: 0 },
          ]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } }, scales: { y: { min: 0 } } }
      }));
    }

    // KR23 Pareto top clients (données réelles — kpi.okr_monthly, dimension client)
    const el23 = document.getElementById('co-kr23') as HTMLCanvasElement | null;
    if (el23) {
      const labels = this.kr23Clients.map(c => c.name);
      const pcts = this.kr23Clients.map(c => c.pct);
      const cums = this.kr23Clients.map(c => c.cum);
      if (labels.length === 0) {
        labels.push('Aucune donnée');
        pcts.push(0);
        cums.push(0);
      }
      this.charts.push(new Chart(el23.getContext('2d')!, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: '% du CA', data: pcts, backgroundColor: C.co, yAxisID: 'y' },
            { label: '% cumulé', data: cums, type: 'line', borderColor: '#3b82f6', yAxisID: 'y1', tension: 0.3, borderWidth: 2, fill: false, pointRadius: 3 } as any,
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 10 } } },
          scales: {
            y: { max: 15, ticks: { callback: (v: any) => v + '%' } },
            y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: (v: any) => v + '%' } }
          }
        }
      }));
    }
  }
}
