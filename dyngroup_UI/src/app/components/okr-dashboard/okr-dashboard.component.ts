import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { DashboardTabComponent } from '../dashboard-tab/dashboard-tab.component';
import { RhTabComponent } from '../rh-tab/rh-tab.component';
import { CommercialTabComponent } from '../commercial-tab/commercial-tab.component';
import { FinanceTabComponent } from '../finance-tab/finance-tab.component';
import { OpsTabComponent } from '../ops-tab/ops-tab.component';
import { OperationnelDashboardComponent } from '../operationnel-dashboard/operationnel-dashboard.component';
import { LogoutButton } from '../../shared/logout-button/logout-button';

@Component({
  selector: 'app-okr-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    DashboardTabComponent,
    RhTabComponent,
    CommercialTabComponent,
    FinanceTabComponent,
    OpsTabComponent,
    OperationnelDashboardComponent,
    LogoutButton,
  ],
  templateUrl: './okr-dashboard.component.html',
  styleUrl: './okr-dashboard.component.css',
})
export class OkrDashboardComponent implements OnInit {
  activeTab: string = 'dashboard';
  theme: 'light' | 'dark' = 'light';
  currentDate: string = '';

  // Active manager filter
  activeManager: string | null = null;
  // Date filters
  startDate: string = '2025-06-01';
  endDate: string = '2026-05-31';

  navItems: { id: string; label: string; icon: SafeHtml }[] = [];
  homeIcon!: SafeHtml;

  owners = [
    { initial: 'E', name: 'Emilie',  kpis: '3 KPIs', bg: '#F0DCF7', border: '#AC4FC6', color: '#AC4FC6', ibg: '#AC4FC6', title: 'KR01, KR02, KR03' },
    { initial: 'G', name: 'Gaël',    kpis: '3 KPIs', bg: '#D6F5DF', border: '#00BB31', color: '#00BB31', ibg: '#00BB31', title: 'KR04, KR05, KR06' },
    { initial: 'J', name: 'Joost',   kpis: '1 KPIs', bg: '#D6E4F7', border: '#0047BB', color: '#0047BB', ibg: '#0047BB', title: 'KR07' },
    { initial: 'M', name: 'Matthieu',kpis: '3 KPIs', bg: '#FFE9CC', border: '#FF8F1C', color: '#FF8F1C', ibg: '#FF8F1C', title: 'KR08, KR09, KR10' },
    { initial: 'S', name: 'Sandrine',kpis: '3 KPIs', bg: '#CCF5F1', border: '#00C7B1', color: '#00C7B1', ibg: '#00C7B1', title: 'KR11, KR12, KR13' },
    { initial: 'S', name: 'Sarah',   kpis: '2 KPIs', bg: '#FFF8CC', border: '#FFCD00', color: '#FFCD00', ibg: '#FFCD00', title: 'KR14, KR15' },
    { initial: 'S', name: 'Sergio',  kpis: '3 KPIs', bg: '#FFE0E0', border: '#E53935', color: '#E53935', ibg: '#E53935', title: 'KR16, KR17, KR18' },
    { initial: 'T', name: 'Thomas',  kpis: '1 KPIs', bg: '#EEEEEE', border: '#555555', color: '#555555', ibg: '#555555', title: 'KR19' },
    { initial: 'V', name: 'Valentin',kpis: '2 KPIs', bg: '#CCE8F5', border: '#0094C6', color: '#0094C6', ibg: '#0094C6', title: 'KR20, KR21' },
    { initial: 'Z', name: 'Zlatan',  kpis: '3 KPIs', bg: '#F5E6D3', border: '#7B3F00', color: '#7B3F00', ibg: '#7B3F00', title: 'KR25, KR26, KR27' },
  ];

  constructor(private sanitizer: DomSanitizer) {}

  get tabLabel(): string {
    const map: Record<string, string> = {
      dashboard: 'Dashboard',
      rh: 'Ressources Humaines',
      commercial: 'Commercial',
      finance: 'Finance',
      ops: 'Opérations',
      operational: 'Opérationnel',
    };
    return map[this.activeTab] ?? this.activeTab;
  }

  ngOnInit() {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    };
    this.currentDate = new Date().toLocaleDateString('fr-CH', options);

    // Build navItems with SafeHtml icons — bypasses Angular sanitizer for inline SVG
    this.navItems = [
      { id: 'dashboard',   label: 'Dashboard',     icon: this.safeIcon('layout-dashboard') },
      { id: 'rh',          label: 'RH',             icon: this.safeIcon('users') },
      { id: 'commercial',  label: 'Commercial',     icon: this.safeIcon('trending-up') },
      { id: 'finance',     label: 'Finance',        icon: this.safeIcon('dollar-sign') },
      { id: 'ops',         label: 'Opérations',     icon: this.safeIcon('settings') },
      { id: 'operational', label: 'Opérationnel',   icon: this.safeIcon('activity') },
    ];
    this.homeIcon = this.safeIcon('home');

    // Apply stored theme
    const stored = localStorage.getItem('dyn_theme') as 'light' | 'dark' | null;
    if (stored) {
      this.theme = stored;
    }
    document.documentElement.setAttribute('data-theme', this.theme);
  }

  setTab(tab: string) {
    this.activeTab = tab;
  }

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', this.theme);
    localStorage.setItem('dyn_theme', this.theme);
  }

  resetFilters() {
    this.activeManager = null;
    this.startDate = '2025-06-01';
    this.endDate = '2026-05-31';
  }

  onManagerChange(event: Event) {
    const val = (event.target as HTMLSelectElement).value;
    this.activeManager = val || null;
  }

  onStartDateChange(event: Event) {
    this.startDate = (event.target as HTMLInputElement).value;
  }

  onEndDateChange(event: Event) {
    this.endDate = (event.target as HTMLInputElement).value;
  }

  /** Marks SVG string as safe HTML so Angular does not strip it */
  private safeIcon(name: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(this.rawSvg(name));
  }

  private rawSvg(name: string): string {
    const base = `xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
    const paths: Record<string, string> = {
      'layout-dashboard': `<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>`,
      'users': `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
      'trending-up': `<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>`,
      'dollar-sign': `<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>`,
      'settings': `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
      'activity': `<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>`,
      'home': `<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>`,
    };
    return `<svg ${base} style="flex-shrink:0;display:block;">${paths[name] ?? ''}</svg>`;
  }
}
