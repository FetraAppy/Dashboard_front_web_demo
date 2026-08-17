import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../shared/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent {
  email = '';
  password = '';
  errorMessage = '';
  isLoading = false;

  constructor(private router: Router, private auth: AuthService) {}

  async onSubmit() {
    if (!this.email || !this.password) return;
    this.isLoading = true;
    this.errorMessage = '';

    const apiBaseUrl = environment.apiUrl;

    try {
      const res = await fetch(`${apiBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.email, password: this.password })
      });

      if (res.ok) {
        const data = await res.json();
        this.auth.setSession(data.token, data.email);
        this.router.navigate(['/']);
      } else {
        const errorData = await res.json();
        this.errorMessage = errorData.error || 'Mot de passe incorrect';
      }
    } catch (err) {
      this.errorMessage = 'Erreur de connexion avec le serveur';
    } finally {
      this.isLoading = false;
    }
  }
}
