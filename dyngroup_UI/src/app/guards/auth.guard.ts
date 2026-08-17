import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../shared/auth.service';

export const authGuard = () => {
  const router = inject(Router);
  const auth = inject(AuthService);

  return auth.isAuthenticated().then(isAuthenticated => {
    if (isAuthenticated) {
      return true;
    }
    router.navigate(['/login']);
    return false;
  });
};
