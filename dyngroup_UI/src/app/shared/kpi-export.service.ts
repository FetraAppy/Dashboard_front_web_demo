import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

/** Paramètres de requête de l'export ; une liste devient un paramètre répété (?companies=A&companies=B). */
export type KpiExportParams = Record<string, string | string[]>;

@Injectable({ providedIn: 'root' })
export class KpiExportService {
  /**
   * Télécharge le .xlsx d'un KPI : GET /api/<dashboard>/export/<kpiId>?<params>.
   * Lève une Error avec le message renvoyé par l'API en cas d'échec (filtre invalide, export
   * trop volumineux, KPI inconnu...).
   */
  async download(dashboard: string, kpiId: string, params: KpiExportParams): Promise<void> {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      (Array.isArray(value) ? value : [value]).forEach(v => query.append(key, v));
    });

    const url = `${environment.apiUrl}/api/${dashboard}/export/${encodeURIComponent(kpiId)}?${query}`;
    const res = await fetch(url);
    if (!res.ok) {
      let message = `Export impossible (erreur ${res.status})`;
      try {
        message = (await res.json()).error || message;
      } catch {
        // réponse non JSON : on garde le message générique
      }
      throw new Error(message);
    }

    const blob = await res.blob();
    const filename = this.filenameFrom(res.headers.get('Content-Disposition')) ?? `${kpiId}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  private filenameFrom(disposition: string | null): string | null {
    if (!disposition) return null;
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (utf8) return decodeURIComponent(utf8[1]);
    const plain = /filename="([^"]+)"/i.exec(disposition);
    return plain ? plain[1] : null;
  }
}
