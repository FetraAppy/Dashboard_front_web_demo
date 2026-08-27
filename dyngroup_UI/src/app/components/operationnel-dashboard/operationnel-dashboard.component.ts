import { Component, ElementRef, Input, ViewChild, AfterViewInit, OnChanges, SimpleChanges, OnDestroy, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Chart, registerables } from 'chart.js';
import { environment } from '../../../environments/environment';
import { FormatService } from '../../shared/format.service';

Chart.register(...registerables);

const MF = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const MS = ['Jan.', 'Fév.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];



@Component({
  selector: 'app-operationnel-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './operationnel-dashboard.component.html',
  styleUrl: './operationnel-dashboard.component.css'
})
export class OperationnelDashboardComponent implements OnInit, AfterViewInit, OnChanges, OnDestroy {
  @Input() isDark: boolean = false;
  constructor(private cdr: ChangeDetectorRef, private fmt: FormatService) { }

  // View state
  activeSubTab = 'indicateurs';
  activeCollab = 'all';
  activeDepartment = 'all';
  activeYear = '2026';
  activeMonth = 'all';
  departmentsList: string[] = [];
  // Day filter removed

  // Constants
  monthNames = MF;
  monthShortNames = MS;
  theoHours: number[] = [];
  // ferieHours: number[] = []; // désactivé — jours fériés retirés du calcul (échelle
  // incohérente avec theoHours en vue "all" : ferieHours était multiplié par l'effectif
  // brut alors que theoHours est déjà prorata par employé, ex. 736h aberrant en janvier)
  caBudget: number[] = [];
  // ETP par mois — Σ H.théoriques employés (net fériés, prorata embauche/départ) ÷
  // H.théorique d'1 employé plein temps référence. Remplace l'ancienne somme de ratios
  // de contrat, non prorata par présence réelle sur l'année (cas BARBEN Thibaut).
  etpMonthly: number[] = [];

  // Synthesis parameters
  tarifHoraire = 180;
  devise = 'CHF';
  heuresTheoAnnuelles = 0;
  heuresProductives = 0;
  heuresFactPotentielles = 0;
  soldeVacances = 0;
  joursFeriesCalcules = 0;
  caBudgetAnnuel = 0;
  caMoyenMensuel = 0;
  etpValue = 0;

  baseMax = 0;
  // totalFeriesHours = 0; // désactivé — jours fériés retirés du calcul, voir ferieHours ci-dessus
  totalCaBudget = 0;

  // Dynamic API Loaded Data
  collabData: Record<string, any> = {};
  globalData: any = {};
  collaboratorsList: string[] = [];

  // Calculated arrays
  filteredRealHours: number[] = [];
  filteredCaReal: number[] = [];
  filteredBillableHours: number[] = [];
  absencesMonth: number[] = [];
  vacationsMonth: number[] = [];
  sicknessMonth: number[] = [];
  vacationsBalance: number[] = [];

  // KPI aggregates
  kpiObjFact = 0;
  kpiCaReal = 0;
  kpiCaEcart = 0;
  kpiProductivity = 0;
  kpiObjectifProductivite = 0;

  // Table summary numbers
  totalTheoHours = 2016;
  totalRealHours = 0;
  totalVarHours = 0;
  totalVacPris = 0;
  finalVacBalance = 0;
  totalAbsences = 0;
  totalFactHours = 0;

  // Chart instances
  private chartHeures: Chart | null = null;
  private chartDonut: Chart | null = null;
  private chartCaEcart: Chart | null = null;
  private chartNonFact: Chart | null = null;

  @ViewChild('chHeuresCanvas') chHeuresCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('chDonutCanvas') chDonutCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('chCaEcartCanvas') chCaEcartCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('chNonFactCanvas') chNonFactCanvas!: ElementRef<HTMLCanvasElement>;

  ngOnInit() {
    this.fetchDashboardData();
  }

  ngAfterViewInit() {
    // Handled after fetching data
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['isDark'] && !changes['isDark'].firstChange) {
      setTimeout(() => {
        this.renderCharts();
      }, 0);
    }
  }

  ngOnDestroy() {
    this.destroyCharts();
  }

  async fetchDashboardData() {
    const apiBaseUrl = environment.apiUrl;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${apiBaseUrl}/api/operationnel/dashboard?annee=${this.activeYear}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        this.collabData = data.collab || {};
        this.globalData = data.global || {};
        this.collaboratorsList = Object.keys(this.collabData).sort();
        this.departmentsList = Array.isArray(data.departments) ? data.departments : [];

        // Update from API computed values
        // Jours fériés retirés du calcul (voir ferieHours plus haut) — on garde uniquement
        // joursFeriesCalcules à titre informatif dans le panneau de synthèse (ne nourrit
        // plus aucun calcul), on ne peuple plus _feriePP/ferieHours.
        if (this.globalData.feries) {
          // this._feriePP = [...this.globalData.feries.parMois];
          // this.ferieHours = [...this._feriePP];
          this.joursFeriesCalcules = this.globalData.feries.totalHeures;
        } else {
          // this._feriePP = Array(12).fill(0);
          // this.ferieHours = Array(12).fill(0);
          this.joursFeriesCalcules = 0;
        }

        if (this.globalData.theoMensuel) {
          this._theoPP = [...this.globalData.theoMensuel.parMois];
          this.theoHours = [...this._theoPP];
          this.heuresTheoAnnuelles = this.globalData.theoMensuel.totalAnnuel;
        } else {
          this._theoPP = Array(12).fill(0);
          this.theoHours = Array(12).fill(0);
          this.heuresTheoAnnuelles = 0;
        }

        this._etpMensuel = Array.isArray(this.globalData.etpMensuel)
          ? [...this.globalData.etpMensuel]
          : Array(12).fill(0);
        // Référence brute (1 employé plein temps, net fériés) — permet de recalculer l'ETP
        // sur un sous-ensemble d'employés (filtre département) sans redemander l'API.
        this._refTheoPP = Array.isArray(this.globalData.refTheoMensuel)
          ? [...this.globalData.refTheoMensuel]
          : Array(12).fill(0);

        if (this.globalData.synthese) {
          const s = this.globalData.synthese;
          this.tarifHoraire = parseFloat(s.tarif_horaire_moyen) || parseFloat(s.tarif_horaire_chf) || 180;
          this.devise = s.devise || 'CHF';
        }
      }
    } catch (err) {
      console.error('Erreur lors du chargement des données opérationnelles :', err);
    }

    this.calculateData();
    this.cdr.detectChanges();
    setTimeout(() => {
      this.renderCharts();
    }, 0);
  }

  switchSubTab(tab: string) {
    this.activeSubTab = tab;
    setTimeout(() => {
      this.renderCharts();
    }, 0);
  }

  onFilterChange() {
    this.calculateData();
    this.renderCharts();
  }

  onYearChange() {
    this.fetchDashboardData();
  }

  /** Département cumulable avec le filtre collaborateur : si le collaborateur sélectionné
   *  n'appartient pas au nouveau département, on revient à "tous" pour ce département. */
  onDepartmentChange() {
    if (this.activeCollab !== 'all'
        && this.activeDepartment !== 'all'
        && this.collabData[this.activeCollab]?.department !== this.activeDepartment) {
      this.activeCollab = 'all';
    }
    this.calculateData();
    this.renderCharts();
  }

  /** Liste des collaborateurs restreinte au département sélectionné (filtre cumulable). */
  get filteredCollaboratorsList(): string[] {
    if (this.activeDepartment === 'all') return this.collaboratorsList;
    return this.collaboratorsList.filter(name => this.collabData[name]?.department === this.activeDepartment);
  }

  resetFilters() {
    this.activeCollab = 'all';
    this.activeDepartment = 'all';
    this.activeYear = '2026';
    this.activeMonth = 'all';
    this.fetchDashboardData();
  }

  getFilterInfo(): string {
    const collabText = this.activeCollab === 'all' ? 'Tous collaborateurs' : this.activeCollab;
    const deptText = this.activeDepartment === 'all' ? null : this.activeDepartment;
    const yearText = this.activeYear;
    const monthText = this.activeMonth === 'all' ? 'Toute l\'année' : MF[parseInt(this.activeMonth)];
    return [collabText, deptText, yearText, monthText].filter(Boolean).join(' · ');
  }

  mathRound(val: number): number {
    return Math.round(val);
  }

  // Objectifs de productivité — remplace un tableau à 5 niveaux (Seuil/0.5/1/1.5/2+) inventé
  // sans formule réelle (20 chiffres tapés à la main dans le tout premier prototype, jamais
  // calculés ni là ni ailleurs — vérifié en remontant au commit d'origine 50dcb12,
  // dashboard_operationnel_v1.html). La vraie règle documentée, retrouvée dans
  // utils/kpi_config.py (OPERATIONAL_DEFAULTS) ET dans le JS de ce même prototype d'origine
  // (`pct>=75 ? 'Objectif atteint' : pct>=69.1 ? 'Proche objectif' : 'Sous objectif'`), est
  // un objectif UNIQUE de 75% comparé au vrai H.théoriques (dynamique, déjà calculé plus haut
  // — prorata par employé, net fériés), avec un seul seuil intermédiaire à 69.1%.
  // readonly seuilsProductivite = [0.691, 0.728, 0.764, 0.822];
  // get refAnnuelleH(): number { return Math.round(this._refTheoPP.reduce((s, v) => s + v, 0)); }
  // get objectifsProductivite(): ... { ... } // ancien tableau à 5 niveaux, voir CORRECTIONS_OPERATIONNEL.md

  /** Cible de productivité annuelle — kpi_config.py: OPERATIONAL_DEFAULTS.objectif_productivite_pct */
  readonly OBJECTIF_PRODUCTIVITE_PCT = 75;
  /** Seuil "proche objectif" — retrouvé dans le JS du prototype d'origine (dashboard_operationnel_v1.html) */
  readonly SEUIL_PROCHE_OBJECTIF_PCT = 69.1;

  /** Statut de la productivité réalisée sur la période affichée (kpiObjectifProductivite,
   *  dynamique, basée sur le vrai H.théoriques) comparée à la cible fixe. */
  get statutObjectifProductivite(): 'atteint' | 'proche' | 'sous' {
    if (this.kpiObjectifProductivite >= this.OBJECTIF_PRODUCTIVITE_PCT) return 'atteint';
    if (this.kpiObjectifProductivite >= this.SEUIL_PROCHE_OBJECTIF_PCT) return 'proche';
    return 'sous';
  }

  /**
   * Calcule dynamiquement le max de l'axe Y (heures) à partir des données
   * affichées, avec une marge de 10% et un arrondi « propre » (pas <= 100).
   */
  private computeYMax(theo: number[], real: number[], isAllMonths: boolean): number {
    const values = [...theo, ...real].filter(v => v > 0);
    if (values.length === 0) {
      return isAllMonths ? 600 : 80;
    }
    const rawMax = Math.max(...values) * 1.1;
    const step = isAllMonths ? 100 : 20;
    return Math.ceil(rawMax / step) * step;
  }

  private _theoPP: number[] = [];
  private _feriePP: number[] = [];
  private _etpMensuel: number[] = [];
  private _refTheoPP: number[] = [];

  /** Dernier mois (index 0-11) avec données réelles, selon la date du jour. */
  get maxMonthIndex(): number {
    const y = parseInt(this.activeYear);
    const now = new Date();
    if (y > now.getFullYear()) return -1;
    if (y === now.getFullYear()) return now.getMonth();
    return 11;
  }

  calculateData() {
    // Reset to pristine per-person values (API), then scale only for "all" view
    this.theoHours = [...this._theoPP];
    // this.ferieHours = [...this._feriePP]; // désactivé — jours fériés retirés du calcul

    let real = Array(12).fill(0);
    let car = Array(12).fill(0);
    let billable = Array(12).fill(0);
    let abs_ = Array(12).fill(0);
    let vac = Array(12).fill(0);
    let mal = Array(12).fill(0);
    let vacInit = 0;

    // Compute annual CA budget from per-employee data
    let caBudgetAnnuelCalcule = 0;

    if (this.activeCollab === 'all') {
      this.caBudget = Array(12).fill(0);

      this.tarifHoraire = this.globalData.synthese?.tarif_horaire_moyen || parseFloat(this.globalData.synthese?.tarif_horaire_chf) || 180;

      // Filtre département (cumulable avec le filtre collaborateur) : ne garder que les
      // employés du département sélectionné avant d'agréger.
      const collabNames = Object.keys(this.collabData).filter(name =>
        this.activeDepartment === 'all' || this.collabData[name].department === this.activeDepartment
      );
      if (collabNames.length > 0) {
        const theoAll = Array(12).fill(0);
        collabNames.forEach(name => {
          const c = this.collabData[name];
          c.real.forEach((v: number, i: number) => real[i] += v);
          c.ca_real.forEach((v: number, i: number) => car[i] += v);
          if (c.billable) c.billable.forEach((v: number, i: number) => billable[i] += v);
          if (c.abs_m) c.abs_m.forEach((v: number, i: number) => abs_[i] += v);
          if (c.theo) c.theo.forEach((v: number, i: number) => theoAll[i] += v);
          c.vac_m.forEach((v: number, i: number) => vac[i] += v);
          c.mal_m.forEach((v: number, i: number) => mal[i] += v);
          vacInit += c.vac_init || 0;

          if (c.ca_bud) c.ca_bud.forEach((v: number, i: number) => this.caBudget[i] += v);
          caBudgetAnnuelCalcule += c.ca_budget_annuel || 0;
        });
        // ETP mensuel = Σ H.théoriques du sous-ensemble affiché (net fériés, prorata) ÷
        // H.théorique d'1 employé plein temps référence. Recalculé depuis la référence brute
        // (pas depuis global.etpMensuel, qui est figé sur toute l'entreprise) pour rester
        // correct quand le filtre département réduit le sous-ensemble d'employés.
        this.etpMonthly = theoAll.map((v, i) => this._refTheoPP[i] > 0 ? v / this._refTheoPP[i] : 0);
        // Theo global = somme des theo par employé (calendrier + prorata, déjà net fériés)
        this.theoHours = theoAll;
      } else {
        this.caBudget = this.globalData.ca_bud || [];
        caBudgetAnnuelCalcule = parseFloat(this.globalData.synthese?.ca_budget_annuel_chf) || 0;
        this.etpMonthly = Array(12).fill(0);
      }
    } else if (this.collabData[this.activeCollab]) {
      const c = this.collabData[this.activeCollab];
      real = [...c.real];
      car = [...c.ca_real];
      billable = c.billable ? [...c.billable] : Array(12).fill(0);
      abs_ = c.abs_m ? [...c.abs_m] : Array(12).fill(0);
      vac = [...c.vac_m];
      mal = [...c.mal_m];
      vacInit = c.vac_init || 0;
      this.theoHours = c.theo ? [...c.theo] : [...this._theoPP];
      // this.ferieHours = [...this._feriePP]; // désactivé — jours fériés retirés du calcul

      this.caBudget = c.ca_bud ? [...c.ca_bud] : (this.globalData.ca_bud || []);
      caBudgetAnnuelCalcule = c.ca_budget_annuel || parseFloat(this.globalData.synthese?.ca_budget_annuel_chf) || 0;
      if (c.tarif_moyen) this.tarifHoraire = c.tarif_moyen;
      // Vue individuelle : ETP = taux d'activité du contrat (ex. 0.8 pour un 80%), pas le
      // ratio théorique/référence utilisé pour le total "Tous collaborateurs".
      this.etpMonthly = Array(12).fill(c.etp || 1);
    } else {
      this.caBudget = this.globalData.ca_bud || [];
      caBudgetAnnuelCalcule = parseFloat(this.globalData.synthese?.ca_budget_annuel_chf) || 0;
      this.etpMonthly = Array(12).fill(0);
    }

    this.caBudgetAnnuel = caBudgetAnnuelCalcule;
    this.caMoyenMensuel = caBudgetAnnuelCalcule / 12;

    // Per-employee vacation balance (per-person for synthesis)
    const nCollab = this.activeCollab === 'all' ? Object.keys(this.collabData).length || 1 : 1;
    this.soldeVacances = vacInit / nCollab;
    // Theo annuel de la vue courante (Σ employés ou individu) → ramené par personne pour la synthèse
    const theoAnnuelView = this.activeCollab === 'all'
      ? Object.values(this.collabData).reduce((s, c: any) => s + (c.theo ? c.theo.reduce((a: number, v: number) => a + v, 0) : 0), 0)
      : (this.collabData[this.activeCollab]?.theo ? this.collabData[this.activeCollab].theo.reduce((a: number, v: number) => a + v, 0) : 0);
    const theoPerPerson = this.activeCollab === 'all' && nCollab > 1 ? theoAnnuelView / nCollab : theoAnnuelView;
    this.heuresProductives = theoPerPerson - this.soldeVacances;
    this.heuresFactPotentielles = theoPerPerson - this.soldeVacances - this.joursFeriesCalcules;

    this.filteredRealHours = real;
    this.filteredCaReal = car;
    this.filteredBillableHours = billable;
    this.absencesMonth = abs_;
    this.vacationsMonth = vac;
    this.sicknessMonth = mal;

    // Calculate dynamic vacation balance progress (table: total for "all", per-person for specific)
    let runningBalance = vacInit;
    this.vacationsBalance = vac.map(v => {
      runningBalance -= v;
      return runningBalance;
    });

    // Determine target month index array (only up to current date)
    const maxIdx = this.maxMonthIndex;
    const monthIndices = this.activeMonth === 'all'
      ? Array.from({ length: Math.max(0, maxIdx + 1) }, (_, i) => i)
      : [parseInt(this.activeMonth)];

    // Aggregates for KPIs
    this.kpiObjFact = monthIndices.reduce((s, i) => s + this.caBudget[i], 0);
    this.kpiCaReal = monthIndices.reduce((s, i) => s + car[i], 0);
    const totalTheo = monthIndices.reduce((s, i) => s + this.theoHours[i], 0);
    const totalReal = monthIndices.reduce((s, i) => s + real[i], 0);

    this.kpiCaEcart = this.kpiCaReal - this.kpiObjFact;
    this.kpiProductivity = totalTheo > 0 ? (totalReal / totalTheo * 100) : 0;

    // Table footers
    this.totalTheoHours = monthIndices.reduce((s, i) => s + this.theoHours[i], 0);
    this.totalRealHours = monthIndices.reduce((s, i) => s + real[i], 0);
    // ETP affiché en pied de tableau = moyenne des ETP mensuels sur la période sélectionnée
    // (un ETP mensuel, pas une somme — sommer des mois donnerait un nombre sans sens).
    this.etpValue = monthIndices.length > 0
      ? monthIndices.reduce((s, i) => s + (this.etpMonthly[i] || 0), 0) / monthIndices.length
      : 0;

    // Total variable hours
    let totVar = 0;
    monthIndices.forEach(i => {
      const v = real[i];
      if (v > 0) {
        // totVar += v - (this.theoHours[i] - (this.ferieHours[i] || 0)); // désactivé — fériés retirés du calcul
        totVar += v - this.theoHours[i];
      }
    });
    this.totalVarHours = totVar;
    this.totalVacPris = monthIndices.reduce((s, i) => s + vac[i], 0);

    if (this.activeMonth === 'all') {
      this.finalVacBalance = this.vacationsBalance[Math.max(0, maxIdx)];
    } else {
      this.finalVacBalance = this.vacationsBalance[parseInt(this.activeMonth)];
    }

    // Absences (toutes absences validées, types via hr_leave_type) — dénominateur de la productivité
    this.totalAbsences = monthIndices.reduce((s, i) => s + abs_[i], 0);

    this.baseMax = Math.max(...this.theoHours);
    // this.totalFeriesHours = monthIndices.reduce((s, i) => s + (this.ferieHours[i] || 0), 0); // désactivé — fériés retirés du calcul
    this.totalCaBudget = monthIndices.reduce((s, i) => s + this.caBudget[i], 0);

    // Heures facturables (account_analytic_line, amount < 0) — numérateur de la productivité
    this.totalFactHours = monthIndices.reduce((s, i) => s + billable[i], 0);

    // Objectif de productivité dynamique : Σ H. facturables / (Σ H. théoriques − Σ absences) × 100
    const baseNette = totalTheo - this.totalAbsences;
    this.kpiObjectifProductivite = baseNette > 0 ? (this.totalFactHours / baseNette) * 100 : 0;
  }

  mathMin(a: number, b: number): number {
    return Math.min(a, b);
  }

  formatNumber(n: number): string {
    return this.fmt.money(n);
  }

  /** Formatage monétaire (CHF) — paramétré centralement */
  money(n: number | null | undefined): string {
    return this.fmt.money(n);
  }

  /** Formatage général (%, x, j, h, pts, ratios…) — paramétré centralement */
  gen(n: number | null | undefined): string {
    return this.fmt.num(n);
  }

  /** Durées (heures théoriques/réalisées/fériés/vacances…) → "203h 35mn", plus d'arrondi direct */
  formatHours(n: number | null | undefined): string {
    return this.fmt.hoursMinutes(n);
  }

  destroyCharts() {
    if (this.chartHeures) { this.chartHeures.destroy(); this.chartHeures = null; }
    if (this.chartDonut) { this.chartDonut.destroy(); this.chartDonut = null; }
    if (this.chartCaEcart) { this.chartCaEcart.destroy(); this.chartCaEcart = null; }
    if (this.chartNonFact) { this.chartNonFact.destroy(); this.chartNonFact = null; }
  }

  renderCharts() {
    this.destroyCharts();

    const textColor = this.isDark ? '#9ca3af' : '#64748b';
    const gridColor = this.isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)';
    const tickFont = { family: 'Montserrat', size: 10, weight: 'bold' as const };

    // --- 1. CHART HEURES ---
    if (this.chHeuresCanvas) {
      const ctx = this.chHeuresCanvas.nativeElement.getContext('2d');
      if (ctx) {
        const isAllMonths = this.activeMonth === 'all';
        const activeMonthIndex = isAllMonths ? -1 : parseInt(this.activeMonth);
        const maxIdx = Math.max(0, this.maxMonthIndex);
        const months = isAllMonths ? Math.max(0, this.maxMonthIndex + 1) : 1;

        const labels = isAllMonths ? MS.slice(0, months) : [MS[activeMonthIndex]];
        const theoData = isAllMonths ? this.theoHours.slice(0, months) : [this.theoHours[activeMonthIndex]];
        const realData = isAllMonths ? this.filteredRealHours.slice(0, months) : [this.filteredRealHours[activeMonthIndex]];
        const realBgColors = isAllMonths
          ? this.filteredRealHours.slice(0, months).map(v => v > 0 ? (this.isDark ? 'rgba(34, 197, 94, 0.35)' : 'rgba(34, 197, 94, 0.7)') : (this.isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.03)'))
          : [this.filteredRealHours[activeMonthIndex] > 0 ? (this.isDark ? 'rgba(34, 197, 94, 0.35)' : 'rgba(34, 197, 94, 0.7)') : (this.isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.03)')];

        let runningVar = 0;
        const cumVarAll = this.filteredRealHours.slice(0, months).map((r, i) => {
          if (r === 0) return null;
          // runningVar += r - (this.theoHours[i] - (this.ferieHours[i] || 0)); // désactivé — fériés retirés du calcul
          runningVar += r - this.theoHours[i];
          return runningVar;
        });
        const cumVarData = isAllMonths ? cumVarAll : [cumVarAll[activeMonthIndex]];

        this.chartHeures = new Chart(ctx, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              {
                label: 'H. théoriques',
                data: theoData,
                backgroundColor: this.isDark ? 'rgba(59, 130, 246, 0.25)' : 'rgba(59, 130, 246, 0.65)',
                borderColor: '#3b82f6',
                borderWidth: 1,
                borderRadius: 4,
                order: 2
              },
              {
                label: 'H. réalisées',
                data: realData,
                backgroundColor: realBgColors,
                borderColor: '#22c55e',
                borderWidth: 1,
                borderRadius: 4,
                order: 2
              },
              {
                label: 'Cumul variable',
                data: cumVarData as any,
                type: 'line',
                borderColor: '#d946ef',
                backgroundColor: 'rgba(217, 70, 239, 0.08)',
                borderWidth: 2.5,
                pointRadius: 5,
                pointBackgroundColor: '#d946ef',
                pointBorderColor: '#fff',
                pointBorderWidth: 1.5,
                tension: 0.35,
                fill: false,
                yAxisID: 'y2',
                order: 1
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { position: 'bottom', labels: { color: textColor, font: tickFont, usePointStyle: true, padding: 14 } },
              tooltip: {
                callbacks: {
                  label: ctx => {
                    const v = ctx.parsed.y;
                    if (ctx.dataset.label === 'Cumul variable') {
                      return v !== null ? ` Cumul variable: ${v > 0 ? '+' : ''}${this.gen(v)}h` : ' Cumul: —';
                    }
                    return v !== null && v > 0 ? ` ${ctx.dataset.label}: ${this.gen(v)}h` : ` ${ctx.dataset.label}: —`;
                  }
                }
              }
            },
            scales: {
              y: {
                min:0,
                ticks: { color: textColor, font: tickFont, callback: v => v + 'h' },
                grid: { color: gridColor },
                max: this.computeYMax(theoData, realData, isAllMonths)
              },
              y2: {
                position: 'right',
                ticks: {
                  color: '#d946ef',
                  font: tickFont,
                  callback: v => {
                    const val = typeof v === 'number' ? v : parseFloat(v as string);
                    return (!isNaN(val) && val > 0 ? '+' : '') + v + 'h';
                  }
                },
                grid: { display: false }
              },
              x: { ticks: { color: textColor, font: tickFont }, grid: { display: false } }
            }
          }
        });
      }
    }

    // --- 2. CHART DONUT ---
    if (this.chDonutCanvas) {
      const ctx = this.chDonutCanvas.nativeElement.getContext('2d');
      if (ctx) {
        const maxIdx = Math.max(0, this.maxMonthIndex);
        const monthIndices = this.activeMonth === 'all'
          ? Array.from({ length: Math.max(0, maxIdx + 1) }, (_, i) => i)
          : [parseInt(this.activeMonth)];
        const monthRatio = monthIndices.length / 12;
        const nCollab = this.activeCollab === 'all' ? Object.keys(this.collabData).length || 1 : 1;
        // theo/ferie déjà agrégés par calculateData (Σ employés en vue "all", individuel sinon)
        const theoAnnuel = monthIndices.reduce((s, i) => s + this.theoHours[i], 0);
        const vacAlloc = this.activeCollab === 'all'
          ? Object.values(this.collabData).reduce((s, c: any) => s + (c.vac_init || 0), 0)
          : (this.collabData[this.activeCollab]?.vac_init || 0);
        const vac = vacAlloc * monthRatio;
        // const fer = monthIndices.reduce((s, i) => s + (this.ferieHours[i] || 0), 0); // désactivé — fériés retirés du calcul
        // const factPot = Math.max(0, theoAnnuel - vac - fer); // désactivé — voir ci-dessus
        const factPot = Math.max(0, theoAnnuel - vac);

        this.chartDonut = new Chart(ctx, {
          type: 'doughnut',
          data: {
            // labels: ['Facturables pot.', 'Vacances', 'Jours fériés'], // désactivé — jours fériés retirés du calcul
            labels: ['Facturables pot.', 'Vacances'],
            datasets: [{
              // data: [factPot, vac, fer], // désactivé — jours fériés retirés du calcul
              data: [factPot, vac],
              // backgroundColor: ['#3b82f6', '#d946ef', '#94a3b8'], // désactivé — jours fériés retirés du calcul
              backgroundColor: ['#3b82f6', '#d946ef'],
              borderWidth: 2,
              borderColor: this.isDark ? '#111827' : '#fff'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: {
              legend: { position: 'bottom', labels: { color: textColor, font: tickFont, usePointStyle: true, padding: 10 } },
              tooltip: {
                callbacks: {
                  label: ctx => ` ${ctx.label}: ${ctx.parsed.toFixed(1)}h (${(ctx.parsed / theoAnnuel * 100).toFixed(1)}%)`
                }
              }
            }
          }
        });
      }
    }

    // --- 3. CHART CA ECART ---
    if (this.chCaEcartCanvas) {
      const ctx = this.chCaEcartCanvas.nativeElement.getContext('2d');
      if (ctx) {
        const isAllMonths = this.activeMonth === 'all';
        const activeMonthIndex = isAllMonths ? -1 : parseInt(this.activeMonth);
        const months = isAllMonths ? Math.max(0, this.maxMonthIndex + 1) : 1;

        const ecartsAll = this.filteredCaReal.slice(0, months).map((v, i) => v > 0 ? v - this.caBudget[i] : null);
        let runningCA = 0;
        const cumCAAll = this.filteredCaReal.slice(0, months).map((v, i) => {
          if (v === 0) return null;
          runningCA += v - this.caBudget[i];
          return runningCA;
        });

        const labels = isAllMonths ? MS.slice(0, months) : [MS[activeMonthIndex]];
        const ecartsData = isAllMonths ? ecartsAll : [ecartsAll[activeMonthIndex]];
        const cumCAData = isAllMonths ? cumCAAll : [cumCAAll[activeMonthIndex]];
        const ecartBgColors = isAllMonths
          ? ecartsAll.map(v => v === null ? (this.isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)') : v >= 0 ? (this.isDark ? 'rgba(34, 197, 94, 0.35)' : 'rgba(34, 197, 94, 0.7)') : (this.isDark ? 'rgba(239, 68, 68, 0.35)' : 'rgba(239, 68, 68, 0.7)'))
          : [ecartsAll[activeMonthIndex] === null ? (this.isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)') : ecartsAll[activeMonthIndex]! >= 0 ? (this.isDark ? 'rgba(34, 197, 94, 0.35)' : 'rgba(34, 197, 94, 0.7)') : (this.isDark ? 'rgba(239, 68, 68, 0.35)' : 'rgba(239, 68, 68, 0.7)')];
        const ecartBorderColors = isAllMonths
          ? ecartsAll.map(v => v === null ? 'transparent' : v >= 0 ? '#22c55e' : '#ef4444')
          : [ecartsAll[activeMonthIndex] === null ? 'transparent' : ecartsAll[activeMonthIndex]! >= 0 ? '#22c55e' : '#ef4444'];

        this.chartCaEcart = new Chart(ctx, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              {
                label: 'Écart CA mensuel',
                data: ecartsData as any,
                backgroundColor: ecartBgColors,
                borderColor: ecartBorderColors,
                borderWidth: 1,
                borderRadius: 4,
                order: 2
              },
              {
                label: 'Cumul CA écart',
                data: cumCAData as any,
                type: 'line',
                borderColor: '#f97316',
                backgroundColor: 'rgba(249, 115, 22, 0.08)',
                borderWidth: 2.5,
                pointRadius: 5,
                pointBackgroundColor: '#f97316',
                pointBorderColor: '#fff',
                pointBorderWidth: 1.5,
                tension: 0.35,
                fill: false,
                yAxisID: 'y2',
                order: 1
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { position: 'bottom', labels: { color: textColor, font: tickFont, usePointStyle: true, padding: 14 } },
              tooltip: {
                callbacks: {
                  label: ctx => {
                    const v = ctx.parsed.y;
                    if (v === null) return ` ${ctx.dataset.label}: —`;
                    return ` ${ctx.dataset.label}: ${v >= 0 ? '+' : ''}${this.money(v)} CHF`;
                  }
                }
              }
            },
            scales: {
              y: {
                ticks: {
                  color: textColor,
                  font: tickFont,
                  callback: v => {
                    const val = typeof v === 'number' ? v : parseFloat(v as string);
                    return this.fmt.money(val / 1000) + 'k';
                  }
                },
                grid: { color: gridColor }
              },
              y2: {
                position: 'right',
                ticks: {
                  color: '#f97316',
                  font: tickFont,
                  callback: v => {
                    const val = typeof v === 'number' ? v : parseFloat(v as string);
                    return (val >= 0 ? '+' : '') + this.fmt.money(val / 1000) + 'k';
                  }
                },
                grid: { display: false }
              },
              x: { ticks: { color: textColor, font: tickFont }, grid: { display: false } }
            }
          }
        });
      }
    }

    // --- 4. CHART NON FACT ---
    if (this.chNonFactCanvas) {
      const ctx = this.chNonFactCanvas.nativeElement.getContext('2d');
      if (ctx) {
        let nf = { admin: 0, vacances: 0, rh_it: 0, marketing: 0, formation: 0, maladie: 0 };

        if (this.activeCollab === 'all') {
          Object.values(this.collabData).forEach(c => {
            if (c.non_fact) {
              Object.keys(nf).forEach(k => {
                const key = k as keyof typeof nf;
                nf[key] += c.non_fact[key] || 0;
              });
            }
          });
        } else if (this.collabData[this.activeCollab]) {
          const c = this.collabData[this.activeCollab];
          if (c.non_fact) {
            Object.keys(nf).forEach(k => {
              const key = k as keyof typeof nf;
              nf[key] = c.non_fact[key] || 0;
            });
          }
        }

        const labels = ['Administratif', 'Vacances', 'RH / IT', 'Marketing', 'Formation', 'Maladie'];
        const values = [nf.admin, nf.vacances, nf.rh_it, nf.marketing, nf.formation, nf.maladie];
        const colors = ['#f97316', '#94a3b8', '#14b8a6', '#d946ef', '#3b82f6', '#ef4444'];

        this.chartNonFact = new Chart(ctx, {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              label: 'Heures non facturables',
              data: values,
              backgroundColor: colors,
              borderColor: colors,
              borderWidth: 1.5,
              borderRadius: 4,
              barThickness: 20
            }]
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: ctx => ctx.parsed.x != null && ctx.parsed.x > 0 ? ` ${this.gen(ctx.parsed.x)}h` : ` —` } }
            },
            scales: {
              x: {
                min: 0,
                ticks: { color: textColor, font: tickFont, stepSize: 50 },
                grid: { color: gridColor }
              },
              y: {
                ticks: { color: textColor, font: { family: 'Montserrat', size: 10, weight: 'bold' as const } },
                grid: { display: false }
              }
            }
          }
        });
      }
    }
  }
}
