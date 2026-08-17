import { Routes } from '@angular/router';
import { OkrDashboardComponent } from './components/okr-dashboard/okr-dashboard.component';
import { OperationnelDashboardComponent } from './components/operationnel-dashboard/operationnel-dashboard.component';
import { LoginComponent } from './components/login/login.component';
import { authGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: '', component: OkrDashboardComponent, canActivate: [authGuard] },
  { path: 'okr', redirectTo: '', pathMatch: 'full' },
  { path: 'operationnel', component: OperationnelDashboardComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: '' },
];

