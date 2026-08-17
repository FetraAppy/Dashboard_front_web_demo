import { Component, ElementRef, HostListener, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService, AUTH_EMAIL_KEY } from '../auth.service';

@Component({
  selector: 'app-logout-button',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './logout-button.html',
  styleUrl: './logout-button.css',
})
export class LogoutButton implements OnInit {
  isOpen = false;
  userName = 'DG';
  userInitials = 'DG';

  constructor(private auth: AuthService, private elementRef: ElementRef) {}

  ngOnInit() {
    const email = localStorage.getItem(AUTH_EMAIL_KEY);
    if (email) {
      this.userName = email.split('@')[0];
      const parts = this.userName.split(/[._-]/).filter(Boolean);
      this.userInitials = parts.length > 1
        ? (parts[0][0] + parts[1][0]).toUpperCase()
        : this.userName.slice(0, 2).toUpperCase();
    }
  }

  toggle() {
    this.isOpen = !this.isOpen;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (!this.elementRef.nativeElement.contains(event.target)) {
      this.isOpen = false;
    }
  }

  logout() {
    this.auth.logout();
  }
}
