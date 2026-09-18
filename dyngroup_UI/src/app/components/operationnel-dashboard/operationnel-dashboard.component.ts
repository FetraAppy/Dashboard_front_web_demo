import { Component, ElementRef, Input, ViewChild, HostListener, AfterViewInit, OnChanges, SimpleChanges, OnDestroy, OnInit, ChangeDetectorRef } from '@angular/core';
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
  // Sociétés sélectionnées (2026-09-18, sélection multiple par cases à cocher) — tableau vide =
  // "toutes les sociétés" (pas de filtre), remplace l'ancien activeCompany à valeur unique.
  activeCompanies: string[] = [];
  companyFilterOpen = false;
  activeYear = '2026';
  activeMonth = 'all';
  // Recherche collaborateur (2026-09-18) : texte tapé en direct, distinct de activeCollab
  // (qui ne prend un nom valide qu'une fois sélectionné). collabSuggestionsOpen pilote
  // l'affichage de la liste déroulante personnalisée (voir collabSuggestions ci-dessous).
  collabSearchText = '';
  collabSuggestionsOpen = false;
  companiesList: string[] = [];
  // Day filter removed

  // Constants
  monthNames = MF;
  monthShortNames = MS;
  theoHours: number[] = [];
  // Théorique année complète (mois futurs inclus, pas de coupure à aujourd'hui) — utilisé par
  // la colonne "H. théoriques" du tableau de suivi mensuel, qui affiche les 12 mois de l'année.
  theoHoursFullYear: number[] = [];
  // ferieHours: number[] = []; // désactivé — jours fériés retirés du calcul (échelle
  // incohérente avec theoHours en vue "all" : ferieHours était multiplié par l'effectif
  // brut alors que theoHours est déjà prorata par employé, ex. 736h aberrant en janvier)
  caBudget: number[] = [];
  // CA objectif CHF (onglet "Objectif" de la fiche employé) — distinct de caBudget (ancien
  // système de budget), utilisé pour le KPI "Objectif" (ex-"Budget") et l'objectif de
  // productivité (CA réalisé / CA objectif).
  caObjectifChf: number[] = [];
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
  baseMaxFullYear = 0;
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
  filteredProductifHours: number[] = [];
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
  totalTheoHours = 0;
  totalTheoHoursFullYear = 0;
  totalRealHours = 0;
  totalVarHours = 0;
  totalVacPris = 0;
  finalVacBalance = 0;
  totalAbsences = 0;
  totalFactHours = 0;
  totalProductifHours = 0;

  // Chart instances
  private chartHeures: Chart | null = null;
  private chartDonut: Chart | null = null;
  private chartCaEcart: Chart | null = null;
  private chartNonFact: Chart | null = null;

  @ViewChild('chHeuresCanvas') chHeuresCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('chDonutCanvas') chDonutCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('chCaEcartCanvas') chCaEcartCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('chNonFactCanvas') chNonFactCanvas!: ElementRef<HTMLCanvasElement>;
  // Champ de recherche collaborateur (2026-09-17) : input non-contrôlé délibérément (pas de
  // [ngModel]/[value] réactif) — sinon Angular réécrirait la valeur tapée à chaque frappe tant
  // qu'elle ne correspond pas encore exactement à un nom connu (cas normal pendant la frappe),
  // effaçant ce que l'utilisateur est en train de taper. On ne synchronise le champ DOM que
  // manuellement (syncCollabSearchInput), quand activeCollab change par un autre moyen que la
  // frappe elle-même (reset, changement de société qui invalide la sélection, etc.).
  @ViewChild('collabSearchInput') collabSearchInputRef?: ElementRef<HTMLInputElement>;
  // Conteneur du filtre Société (2026-09-18, sélection multiple) — utilisé par onDocumentClick
  // pour fermer le menu de cases à cocher au clic en dehors.
  @ViewChild('companyFilterContainer') companyFilterContainerRef?: ElementRef<HTMLElement>;

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
        // Filtre "Société" (2026-09-17, remplace le filtre Département — le regroupement
        // Administration/Autre ne correspondait plus à aucun département réel dans Odoo).
        // Liste des sociétés réellement présentes parmi les collaborateurs (API : data.companies).
        this.companiesList = Array.isArray(data.companies) ? data.companies : [];

        // Update from API computed values
        // Jours fériés retirés du calcul (voir ferieHours plus haut) — on garde uniquement
        // joursFeriesCalcules à titre informatif dans le panneau de synthèse (ne nourrit
        // plus aucun calcul), on ne peuple plus _feriePP/ferieHours.
        if (this.globalData.feriesFullYear) {
          // this._feriePP = [...this.globalData.feries.parMois];
          // this.ferieHours = [...this._feriePP];
          // Année complète (pas "à ce jour") — cohérent avec heuresTheoAnnuelles, vérifié
          // contre une feuille de référence RH (10 jours fériés/an = 80h pour un employé
          // présent toute l'année, contre 6 jours/48h si on s'arrête à aujourd'hui).
          this.joursFeriesCalcules = this.globalData.feriesFullYear.totalHeures;
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
    this.syncCollabSearchInput();
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

  /** Société réelle d'un employé (2026-09-17, remplace deptBucket/Administration-Autre). */
  companyOf(name: string): string | null {
    return this.collabData[name]?.company || null;
  }

  /** Recale la valeur affichée du champ de recherche collaborateur sur activeCollab — à
   *  appeler après tout changement de activeCollab qui NE VIENT PAS de la frappe elle-même
   *  (chargement initial, reset, société qui invalide la sélection courante). Voir le
   *  commentaire sur collabSearchInputRef pour pourquoi ce champ n'est pas [ngModel]/[value]. */
  syncCollabSearchInput() {
    const text = this.activeCollab === 'all' ? '' : this.activeCollab;
    this.collabSearchText = text;
    const input = this.collabSearchInputRef?.nativeElement;
    if (input) input.value = text;
  }

  /** Au focus (2026-09-18) : sélectionne tout le texte déjà présent (ex: "AGACHII Igor"), pour
   *  que la première frappe le remplace directement — sans ça, il fallait effacer le nom déjà
   *  choisi à la main avant de pouvoir en chercher un autre. Affiche aussi la liste complète des
   *  collaborateurs (pas seulement ceux qui matchent le nom actuellement affiché) : le texte
   *  visible dans le champ n'est pas touché (il reste sélectionné jusqu'à la prochaine frappe),
   *  seule la liste déroulante des suggestions se réinitialise à "tout le monde".
   */
  onCollabSearchFocus() {
    this.collabSearchText = '';
    this.collabSuggestionsOpen = true;
    this.collabSearchInputRef?.nativeElement.select();
  }

  /** Normalise pour une comparaison insensible à la casse ET aux accents (ex: "ines" doit
   *  matcher "Inês") — demande utilisateur du 2026-09-18 : le <datalist> HTML natif ne permet
   *  pas ça, le navigateur re-filtre lui-même les options de façon sensible aux accents même si
   *  on lui fournit déjà une liste pré-filtrée, d'où la liste déroulante personnalisée ci-dessous
   *  (collabSuggestions/collabSuggestionsOpen) à la place d'un <datalist>. */
  private normalizeSearch(s: string): string {
    return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }

  /** Suggestions affichées sous le champ de recherche collaborateur, filtrées de façon
   *  insensible aux accents/casse sur le texte tapé (collabSearchText). */
  get collabSuggestions(): string[] {
    const q = this.normalizeSearch(this.collabSearchText);
    const base = this.filteredCollaboratorsList;
    if (!q) return base;
    return base.filter(name => this.normalizeSearch(name).includes(q));
  }

  /** Appelé à chaque frappe dans le champ de recherche collaborateur (input non-contrôlé). Met
   *  à jour les suggestions affichées ; ne change activeCollab que si le texte correspond
   *  EXACTEMENT (insensible accents/casse) à un nom connu — sinon on laisse l'utilisateur
   *  continuer de taper sans rien casser (le choix se fait normalement via selectCollab, en
   *  cliquant une suggestion). */
  onCollabSearchInput(value: string) {
    this.collabSearchText = value;
    this.collabSuggestionsOpen = true;
    const trimmed = (value || '').trim();
    if (!trimmed) {
      if (this.activeCollab !== 'all') {
        this.activeCollab = 'all';
        this.onFilterChange();
      }
      return;
    }
    const normalizedTyped = this.normalizeSearch(trimmed);
    const match = this.filteredCollaboratorsList.find(name => this.normalizeSearch(name) === normalizedTyped);
    if (match && match !== this.activeCollab) {
      this.activeCollab = match;
      this.onFilterChange();
    }
  }

  /** Sélection d'un collaborateur dans la liste déroulante personnalisée (clic). */
  selectCollab(name: string) {
    this.activeCollab = name;
    this.collabSuggestionsOpen = false;
    this.syncCollabSearchInput();
    this.onFilterChange();
  }

  /** Ferme la liste de suggestions un instant après avoir perdu le focus (délai pour laisser le
   *  temps au (click) sur une suggestion de se déclencher avant que *ngIf ne la retire du DOM). */
  onCollabSearchBlur() {
    setTimeout(() => { this.collabSuggestionsOpen = false; }, 150);
  }

  /** Sociétés cumulables avec le filtre collaborateur (sélection multiple, 2026-09-18) : si le
   *  collaborateur sélectionné n'appartient à AUCUNE des sociétés cochées, on revient à "tous"
   *  pour ce filtre. */
  onCompanyChange() {
    if (this.activeCollab !== 'all'
        && this.activeCompanies.length > 0
        && !this.activeCompanies.includes(this.companyOf(this.activeCollab) || '')) {
      this.activeCollab = 'all';
      this.syncCollabSearchInput();
    }
    this.calculateData();
    this.renderCharts();
  }

  /** Coche/décoche une société dans le filtre multi-sélection. */
  toggleCompany(company: string) {
    const idx = this.activeCompanies.indexOf(company);
    if (idx >= 0) {
      this.activeCompanies.splice(idx, 1);
    } else {
      this.activeCompanies.push(company);
    }
    this.onCompanyChange();
  }

  isCompanySelected(company: string): boolean {
    return this.activeCompanies.includes(company);
  }

  /** Vide la sélection de sociétés ("toutes les sociétés"). */
  clearCompanies() {
    if (this.activeCompanies.length === 0) return;
    this.activeCompanies = [];
    this.onCompanyChange();
  }

  /** Libellé affiché sur le bouton du filtre Société (résumé de la sélection). */
  get companyFilterLabel(): string {
    if (this.activeCompanies.length === 0) return 'Toutes les sociétés';
    if (this.activeCompanies.length === 1) return this.activeCompanies[0];
    return `${this.activeCompanies.length} sociétés`;
  }

  /** Ferme le filtre Société au clic en dehors de son conteneur (les cases à cocher doivent
   *  rester ouvertes tant qu'on coche/décoche, contrairement à un simple blur). */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.companyFilterOpen
        && this.companyFilterContainerRef
        && !this.companyFilterContainerRef.nativeElement.contains(event.target as Node)) {
      this.companyFilterOpen = false;
    }
  }

  /** Liste des collaborateurs restreinte aux sociétés sélectionnées (filtre cumulable,
   *  sélection multiple depuis 2026-09-18). */
  get filteredCollaboratorsList(): string[] {
    if (this.activeCompanies.length === 0) return this.collaboratorsList;
    return this.collaboratorsList.filter(name => {
      const c = this.companyOf(name);
      return c !== null && this.activeCompanies.includes(c);
    });
  }

  resetFilters() {
    this.activeCollab = 'all';
    this.activeCompanies = [];
    this.activeYear = '2026';
    this.activeMonth = 'all';
    this.fetchDashboardData();
  }

  getFilterInfo(): string {
    const collabText = this.activeCollab === 'all' ? 'Tous collaborateurs' : this.activeCollab;
    const companyText = this.activeCompanies.length === 0 ? null : this.companyFilterLabel;
    const yearText = this.activeYear;
    const monthText = this.activeMonth === 'all' ? 'Toute l\'année' : MF[parseInt(this.activeMonth)];
    return [collabText, companyText, yearText, monthText].filter(Boolean).join(' · ');
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

  /** Statut de la carte EFFICACITÉ (kpiProductivity = heures productives ÷ heures réalisées),
   *  mesure distincte de statutObjectifProductivite depuis le retour arrière du 2026-09-14 —
   *  voir kpiProductivity dans calculateData(). Mêmes seuils que l'ancienne cible historique. */
  get statutProductivite(): 'atteint' | 'proche' | 'sous' {
    if (this.kpiProductivity >= this.OBJECTIF_PRODUCTIVITE_PCT) return 'atteint';
    if (this.kpiProductivity >= this.SEUIL_PROCHE_OBJECTIF_PCT) return 'proche';
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
    let productif = Array(12).fill(0);
    let abs_ = Array(12).fill(0);
    let vac = Array(12).fill(0);
    let mal = Array(12).fill(0);
    let vacInit = 0;

    // Compute annual CA budget from per-employee data
    let caBudgetAnnuelCalcule = 0;

    // Filtre société (cumulable avec le filtre collaborateur, 2026-09-17 remplace le filtre
    // département), calculé une seule fois et réutilisé aussi pour la synthèse annuelle
    // (H. théoriques, H. productives, H. facturables potentielles, Solde vacances).
    const collabNamesDept = Object.keys(this.collabData).filter(name =>
      this.activeCompanies.length === 0 || this.activeCompanies.includes(this.companyOf(name) || '')
    );

    if (this.activeCollab === 'all') {
      this.caBudget = Array(12).fill(0);
      this.caObjectifChf = Array(12).fill(0);

      this.tarifHoraire = this.globalData.synthese?.tarif_horaire_moyen || parseFloat(this.globalData.synthese?.tarif_horaire_chf) || 180;

      const collabNames = collabNamesDept;
      if (collabNames.length > 0) {
        const theoAll = Array(12).fill(0);
        const theoFullYearAll = Array(12).fill(0);
        const theo100All = Array(12).fill(0);
        collabNames.forEach(name => {
          const c = this.collabData[name];
          c.real.forEach((v: number, i: number) => real[i] += v);
          c.ca_real.forEach((v: number, i: number) => car[i] += v);
          if (c.billable) c.billable.forEach((v: number, i: number) => billable[i] += v);
          if (c.productif) c.productif.forEach((v: number, i: number) => productif[i] += v);
          if (c.abs_m) c.abs_m.forEach((v: number, i: number) => abs_[i] += v);
          if (c.theo) c.theo.forEach((v: number, i: number) => theoAll[i] += v);
          if (c.theoFullYear) c.theoFullYear.forEach((v: number, i: number) => theoFullYearAll[i] += v);
          if (c.theo100) c.theo100.forEach((v: number, i: number) => theo100All[i] += v);
          c.vac_m.forEach((v: number, i: number) => vac[i] += v);
          c.mal_m.forEach((v: number, i: number) => mal[i] += v);
          vacInit += c.vac_init || 0;

          if (c.ca_bud) c.ca_bud.forEach((v: number, i: number) => this.caBudget[i] += v);
          if (c.ca_objectif_chf) c.ca_objectif_chf.forEach((v: number, i: number) => this.caObjectifChf[i] += v);
          caBudgetAnnuelCalcule += c.ca_budget_annuel || 0;
        });
        // ETP mensuel = H.théoriques réelles (contrat) ÷ H.théoriques référence 100% (même
        // fenêtre de présence et canton, sans le taux d'activité) — demande utilisateur du
        // 2026-09-16, remplace l'ancien réalisé/théorique (qui restait "Taux effort", une
        // mesure différente : le fait de travailler plus/moins que son contrat). Plafonné à 1 :
        // un ETP mensuel ne doit jamais dépasser 100%, même pour un collectif en heures sup.
        this.etpMonthly = theoAll.map((t, i) => theo100All[i] > 0 ? Math.min(1, Math.round((t / theo100All[i]) * 100) / 100) : 0);
        // Theo global = somme des theo par employé (calendrier + prorata, déjà net fériés)
        this.theoHours = theoAll;
        // Théorique année complète (mois futurs inclus) — pour la colonne "H. théoriques" du
        // tableau de suivi mensuel, qui affiche désormais les 12 mois, pas seulement "à ce jour".
        this.theoHoursFullYear = theoFullYearAll;
      } else {
        this.caBudget = this.globalData.ca_bud || [];
        this.caObjectifChf = Array(12).fill(0);
        caBudgetAnnuelCalcule = parseFloat(this.globalData.synthese?.ca_budget_annuel_chf) || 0;
        this.etpMonthly = Array(12).fill(0);
        this.theoHoursFullYear = Array(12).fill(0);
      }
    } else if (this.collabData[this.activeCollab]) {
      const c = this.collabData[this.activeCollab];
      real = [...c.real];
      car = [...c.ca_real];
      billable = c.billable ? [...c.billable] : Array(12).fill(0);
      productif = c.productif ? [...c.productif] : Array(12).fill(0);
      abs_ = c.abs_m ? [...c.abs_m] : Array(12).fill(0);
      vac = [...c.vac_m];
      mal = [...c.mal_m];
      vacInit = c.vac_init || 0;
      this.theoHours = c.theo ? [...c.theo] : [...this._theoPP];
      this.theoHoursFullYear = c.theoFullYear ? [...c.theoFullYear] : [...this.theoHours];
      // this.ferieHours = [...this._feriePP]; // désactivé — jours fériés retirés du calcul

      this.caBudget = c.ca_bud ? [...c.ca_bud] : (this.globalData.ca_bud || []);
      this.caObjectifChf = c.ca_objectif_chf ? [...c.ca_objectif_chf] : Array(12).fill(0);
      caBudgetAnnuelCalcule = c.ca_budget_annuel || parseFloat(this.globalData.synthese?.ca_budget_annuel_chf) || 0;
      // tarif_effectif = CA réalisé ÷ heures réalisées de l'employé (moyenne pondérée réelle,
      // voir backend) — plus représentatif que tarif_moyen (tarif de référence statique) quand
      // plusieurs tarifs mensuels différents ont été appliqués dans l'année.
      if (c.tarif_effectif) this.tarifHoraire = c.tarif_effectif;
      // ETP mensuel = H.théoriques réelles (contrat) ÷ H.théoriques référence 100% — même
      // formule que la vue "Tous collaborateurs" (voir ci-dessus). Plafonné à 1.
      const theo100 = c.theo100 || Array(12).fill(0);
      this.etpMonthly = this.theoHours.map((t, i) => theo100[i] > 0 ? Math.min(1, Math.round((t / theo100[i]) * 100) / 100) : 0);
    } else {
      this.caBudget = this.globalData.ca_bud || [];
      this.caObjectifChf = Array(12).fill(0);
      caBudgetAnnuelCalcule = parseFloat(this.globalData.synthese?.ca_budget_annuel_chf) || 0;
      this.etpMonthly = Array(12).fill(0);
    }

    this.caBudgetAnnuel = caBudgetAnnuelCalcule;
    this.caMoyenMensuel = caBudgetAnnuelCalcule / 12;

    // Per-employee vacation balance (per-person for synthesis) — nCollab = effectif du groupe
    // FILTRÉ par département (collabNamesDept), pas l'effectif total de l'entreprise : corrige
    // l'incohérence numérateur (déjà filtré) / dénominateur (ne l'était pas) sur Solde vacances.
    const nCollab = this.activeCollab === 'all' ? (collabNamesDept.length || 1) : 1;
    // Solde vacances = solde RESTANT (allocation − déjà pris), pas l'allocation brute — vérifié
    // sur AGACHII Igor : 176h allouées − 136h déjà prises (fev→août) = 40h, exactement le
    // "Solde heure vacances" de la feuille de référence RH. Avant cette correction, le champ
    // affichait l'allocation brute (176h), ce qui contredisait son propre nom ("solde").
    const vacPrisTotal = vac.reduce((a, v) => a + v, 0);
    this.soldeVacances = (vacInit - vacPrisTotal) / nCollab;
    // Theo annuel = ANNÉE COMPLÈTE (theoFullYear, pas theo "à ce jour") du groupe filtré
    // (département + collaborateur). Vérifié sur Igor : notre "à ce jour" donnait 1'384h contre
    // 2'016h sur la feuille de référence (l'année entière, y compris les mois futurs en
    // projection) — theoFullYear ne coupe pas à aujourd'hui, contrairement à theo (utilisé par
    // le graphique mensuel, qui doit lui rester "à ce jour").
    const theoAnnuelView = this.activeCollab === 'all'
      ? collabNamesDept.reduce((s, name) => {
          const c = this.collabData[name];
          return s + (c.theoFullYear ? c.theoFullYear.reduce((a: number, v: number) => a + v, 0) : 0);
        }, 0)
      : (this.collabData[this.activeCollab]?.theoFullYear
          ? this.collabData[this.activeCollab].theoFullYear.reduce((a: number, v: number) => a + v, 0)
          : 0);
    // H. théoriques annuelles = total du groupe actuellement filtré (département + collaborateur)
    // — avant cette correction, cette valeur venait d'un total figé sur toute l'entreprise
    // (globalData.theoMensuel.totalAnnuel), jamais recalculé par les filtres.
    this.heuresTheoAnnuelles = theoAnnuelView;

    const theoPerPerson = this.activeCollab === 'all' && nCollab > 1 ? theoAnnuelView / nCollab : theoAnnuelView;
    this.heuresProductives = theoPerPerson - this.soldeVacances;
    // H. facturables potentielles = H. productives moins les absences réelles déjà connues
    // (maladie + autres absences), moyenne par personne sur le groupe filtré. Remplace l'ancienne
    // soustraction de joursFeriesCalcules : celle-ci doublait une déduction déjà faite dans le
    // calcul du théorique par employé (computeTheoMensuelEmployee est déjà net des fériés
    // vaudois tombant dans la fenêtre de présence de chaque employé).
    const malAnnuel = mal.reduce((a, v) => a + v, 0);
    const absAnnuel = abs_.reduce((a, v) => a + v, 0);
    this.heuresFactPotentielles = this.heuresProductives - (malAnnuel + absAnnuel) / nCollab;

    this.filteredRealHours = real;
    this.filteredCaReal = car;
    this.filteredBillableHours = billable;
    this.filteredProductifHours = productif;
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
    // Mêmes mois, mais sur l'année complète (pas limité à aujourd'hui) — pour le tableau de
    // suivi mensuel, qui affiche désormais les 12 mois avec leur théorique complet.
    const monthIndicesFullYear = this.activeMonth === 'all'
      ? Array.from({ length: 12 }, (_, i) => i)
      : [parseInt(this.activeMonth)];

    // Aggregates for KPIs
    // kpiObjFact = "CA objectif" (carte "OBJECTIF", ex-"BUDGET") — vient de l'onglet "Objectif"
    // de la fiche employé (x_studio_objectif_chf), pas de l'ancien système de budget (caBudget).
    // Somme sur l'année complète (monthIndicesFullYear), pas capée au mois courant (monthIndices)
    // comme le CA réalisé : un objectif peut déjà être saisi dans Odoo pour des mois futurs
    // (ex: Igor a un objectif d'octobre alors qu'on n'y est pas encore) — corrigé le 2026-09-16,
    // le total "tous les mois" ignorait ces objectifs futurs.
    this.kpiObjFact = monthIndicesFullYear.reduce((s, i) => s + this.caObjectifChf[i], 0);
    this.kpiCaReal = monthIndices.reduce((s, i) => s + car[i], 0);

    this.kpiCaEcart = this.kpiCaReal - this.kpiObjFact;

    // Table footers
    this.totalTheoHours = monthIndices.reduce((s, i) => s + this.theoHours[i], 0);
    this.totalTheoHoursFullYear = monthIndicesFullYear.reduce((s, i) => s + (this.theoHoursFullYear[i] || 0), 0);
    this.totalRealHours = monthIndices.reduce((s, i) => s + real[i], 0);
    // ETP affiché en pied de tableau = somme des ETP mensuels sur la période sélectionnée
    // (total, pas moyenne — demande utilisateur du 2026-09-11).
    this.etpValue = monthIndices.reduce((s, i) => s + (this.etpMonthly[i] || 0), 0);

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
    this.baseMaxFullYear = Math.max(...this.theoHoursFullYear);
    // this.totalFeriesHours = monthIndices.reduce((s, i) => s + (this.ferieHours[i] || 0), 0); // désactivé — fériés retirés du calcul
    this.totalCaBudget = monthIndices.reduce((s, i) => s + this.caBudget[i], 0);

    // Heures facturables (account_analytic_line, amount < 0) — numérateur de la productivité
    this.totalFactHours = monthIndices.reduce((s, i) => s + billable[i], 0);
    // Heures productives — nouvelle définition (compte-rendu productivity=true), utilisée par
    // le tableau "Suivi mensuel détaillé" (H. Productivité / Taux Productivité, total).
    this.totalProductifHours = monthIndices.reduce((s, i) => s + productif[i], 0);

    // Objectif de productivité = CA réalisé / CA objectif × 100 — carte CIBLE.
    this.kpiObjectifProductivite = this.kpiObjFact > 0 ? (this.kpiCaReal / this.kpiObjFact) * 100 : 0;
    // Productivité mensuelle = heures productives ÷ heures réalisées × 100 — carte EFFICACITÉ.
    // Redevient une mesure distincte du taux réel de travail productif (même formule que "Taux
    // Productivité" du tableau détaillé), après retour arrière du 2026-09-14 : la fusion avec
    // "Objectif de productivité" (CA réalisé/CA objectif) du 2026-09-11 portait à confusion, les
    // deux cartes mesurant des choses différentes (efficacité réelle vs atteinte d'un objectif financier).
    this.kpiProductivity = this.totalRealHours > 0 ? (this.totalProductifHours / this.totalRealHours) * 100 : 0;
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

        // Un mois sans objectif CHF réel (caObjectifChf = 0, aucune donnée Odoo saisie pour ce
        // périmètre dans l'onglet "Objectif") ne peut pas produire un "écart" valide — sinon tout
        // le CA réalisé apparaît à tort comme un dépassement de 100%. On traite ces mois comme
        // sans donnée (null) plutôt que de comparer à un objectif à zéro.
        const ecartsAll = this.filteredCaReal.slice(0, months).map((v, i) =>
          (v > 0 && this.caObjectifChf[i] > 0) ? v - this.caObjectifChf[i] : null);
        let runningCA = 0;
        const cumCAAll = this.filteredCaReal.slice(0, months).map((v, i) => {
          if (v === 0 || this.caObjectifChf[i] === 0) return null;
          runningCA += v - this.caObjectifChf[i];
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
                label: 'Objectif mensuel (écart)',
                data: ecartsData as any,
                backgroundColor: ecartBgColors,
                borderColor: ecartBorderColors,
                borderWidth: 1,
                borderRadius: 4,
                order: 2
              },
              {
                label: 'Objectif cumulé (écart)',
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

        // Mois retenus : un seul mois sélectionné, ou tous les mois écoulés — même logique
        // que les autres graphiques/tableaux (maxMonthIndex borne à aujourd'hui).
        const maxIdx = Math.max(0, this.maxMonthIndex);
        const monthIndices = this.activeMonth === 'all'
          ? Array.from({ length: maxIdx + 1 }, (_, i) => i)
          : [parseInt(this.activeMonth)];

        // Collaborateurs retenus : filtre société (cumulable) + filtre collaborateur,
        // même logique que calculateData().
        const collabNames = this.activeCollab === 'all'
          ? Object.keys(this.collabData).filter(name =>
              this.activeCompanies.length === 0 || this.activeCompanies.includes(this.companyOf(name) || ''))
          : (this.collabData[this.activeCollab] ? [this.activeCollab] : []);

        collabNames.forEach(name => {
          const c = this.collabData[name];
          if (c?.non_fact) {
            Object.keys(nf).forEach(k => {
              const key = k as keyof typeof nf;
              const arr: number[] = c.non_fact[key] || [];
              monthIndices.forEach(i => { nf[key] += arr[i] || 0; });
            });
          }
        });

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
