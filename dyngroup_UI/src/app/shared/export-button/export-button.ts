import { Component, Input } from '@angular/core';
import { KpiExportParams, KpiExportService } from '../kpi-export.service';

/**
 * Bouton "Excel" à placer sur un KPI : télécharge l'export .xlsx de ce KPI avec les filtres
 * actifs du dashboard, passés via `params` (ex. [params]="exportParams" côté Opérationnel).
 */
@Component({
  selector: 'app-export-button',
  standalone: true,
  templateUrl: './export-button.html',
  styleUrl: './export-button.css',
})
export class ExportButton {
  @Input() dashboard = 'operationnel';
  @Input({ required: true }) kpiId!: string;
  @Input({ required: true }) params!: KpiExportParams;

  loading = false;

  constructor(private exportService: KpiExportService) {}

  async export() {
    if (this.loading) return;
    this.loading = true;
    try {
      await this.exportService.download(this.dashboard, this.kpiId, this.params);
    } catch (err: any) {
      alert(err?.message || "L'export Excel a échoué.");
    } finally {
      this.loading = false;
    }
  }
}
