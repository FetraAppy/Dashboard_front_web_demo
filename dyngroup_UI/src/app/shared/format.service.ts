import { Injectable } from '@angular/core';

/**
 * Configuration CENTRALE du formatage des nombres pour tout le frontend.
 * Modifiez ces deux valeurs pour changer l'affichage de toutes les données.
 */
export const MONETARY_DECIMALS = 0; // décimales pour les montants (CHF, kCHF, M CHF)
export const GENERAL_DECIMALS = 2;  // décimales pour le reste (%, x, j, h, pts, ratios…)

@Injectable({ providedIn: 'root' })
export class FormatService {
  /** Séparateur de milliers (apostrophe suisse) + décimales paramétrables */
  private format(value: number, decimals: number): string {
    if (value === null || value === undefined || isNaN(value)) return '—';
    const fixed = Number(value).toFixed(decimals);
    const [intPart, decPart] = fixed.split('.');
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
    return decPart ? `${grouped}.${decPart}` : grouped;
  }

  /** Montants monétaires (CHF) */
  money(value: number | null | undefined): string {
    if (value === null || value === undefined || isNaN(value as number)) return '—';
    return this.format(value, MONETARY_DECIMALS);
  }

  /** Valeurs générales (%, x, j, h, pts, ratios…) */
  num(value: number | null | undefined): string {
    if (value === null || value === undefined || isNaN(value as number)) return '—';
    return this.format(value, GENERAL_DECIMALS);
  }

  /** Pourcentages */
  pct(value: number | null | undefined): string {
    return this.num(value);
  }

  /** Entiers (sans décimale) */
  int(value: number | null | undefined): string {
    if (value === null || value === undefined || isNaN(value as number)) return '—';
    return this.format(value, 0);
  }
}
