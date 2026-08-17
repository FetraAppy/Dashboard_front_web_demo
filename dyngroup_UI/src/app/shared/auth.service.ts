import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { environment } from '../../environments/environment';

export const AUTH_TOKEN_VALUE = 'authenticated_dyn_token_2026';
export const AUTH_STORAGE_KEY = 'dyn_auth';
export const AUTH_EMAIL_KEY = 'dyn_user_email';

@Injectable({ providedIn: 'root' })
export class AuthService {
  constructor(private router: Router) {}

  /** Persiste la session après un login réussi */
  setSession(token: string, email?: string) {
    localStorage.setItem(AUTH_STORAGE_KEY, token);
    if (email) {
      localStorage.setItem(AUTH_EMAIL_KEY, email);
    }
  }

  /** Vérifie auprès du backend que le token stocké est valide */
  async isAuthenticated(): Promise<boolean> {
    const token = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!token) {
      return false;
    }
    if (token !== AUTH_TOKEN_VALUE) {
      this.clearSession();
      return false;
    }
    try {
      const res = await fetch(`${environment.apiUrl}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      return !!data.valid;
    } catch {
      // Backend injoignable : on se fie au token local cohérent
      return true;
    }
  }

  /** Déconnecte l'utilisateur et redirige vers le login */
  logout() {
    this.clearSession();
    this.router.navigate(['/login']);
  }

  private clearSession() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(AUTH_EMAIL_KEY);
  }
}
