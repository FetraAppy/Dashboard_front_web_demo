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

  /** Montants monétaires avec un nombre de décimales choisi — pour un affichage ponctuel plus
   *  précis (ex. dashboard Finance) sans changer MONETARY_DECIMALS globalement pour tout le
   *  reste de l'app (Opérationnel, etc.). */
  moneyDecimals(value: number | null | undefined, decimals: number): string {
    if (value === null || value === undefined || isNaN(value as number)) return '—';
    return this.format(value, decimals);
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

  /** Durées en heures décimales → "203h 35mn" (au lieu d'un arrondi direct à l'heure) */
  hoursMinutes(value: number | null | undefined): string {
    if (value === null || value === undefined || isNaN(value as number)) return '—';
    const sign = value < 0 ? '-' : '';
    const totalMinutes = Math.round(Math.abs(value) * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const hGrouped = h.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
    return `${sign}${hGrouped}h ${m.toString().padStart(2, '0')}mn`;
  }
}
