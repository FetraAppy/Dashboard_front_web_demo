# Déploiement Dyngroup Dashboard

Résumé du déploiement Vercel et de l'état des données au 2026-08-18.

## Architecture

Repo mono-dossier contenant deux apps indépendantes, déployées comme **deux projets Vercel séparés** :

| App | Dossier | Stack | Projet Vercel |
|---|---|---|---|
| API | `dyngroup_api` | Express + TypeScript + PostgreSQL (`pg`) | `dyngroup-api` → `https://dyngroup-api.vercel.app` |
| Frontend | `dyngroup_UI` | Angular 22 + Chart.js | `dyngroup-ui` (nom libre, non câblé en dur) |

Le lien entre les deux est **hardcodé** dans `dyngroup_UI/src/environments/environment.prod.ts` (`apiUrl: 'https://dyngroup-api.vercel.app'`), utilisé lors du build de prod via le `fileReplacements` d'`angular.json`. Si l'URL de l'API change, il faut éditer ce fichier manuellement (la variable d'env `API_URL` du script `prebuild` ne sert qu'en dev local, pas en build de prod).

## Déploiement — API (`dyngroup_api`)

- **Root Directory** : `dyngroup_api`
- **Framework Preset** : Other (le `vercel.json` du dossier gère le build via `@vercel/node` sur `api/index.ts`, pas besoin de build/output command custom)
- **Variables d'environnement** (Vercel → Settings → Environment Variables, valeurs dans `dyngroup_api/.env` en local, jamais commit) :
  - `DATABASE_URL` — Postgres Cloud SQL GCP, IP fixe `34.65.51.39:5432`, base `dashboard` (endpoint exposé par le pipeline ETL Airflow)
  - `DASHBOARD_EMAIL`
  - `DASHBOARD_PASSWORD`
- Connexion sans SSL (aucune config SSL dans `pool.ts`, fonctionne tel quel en local comme en prod)
- **Statut** : déployé, répond correctement (`Cannot GET /` sur la racine est normal — toutes les routes sont sous `/api/...`)

## Déploiement — Frontend (`dyngroup_UI`)

- **Root Directory** : `dyngroup_UI`
- **Framework Preset** : Angular (auto-détecté), mais `vercel.json` du dossier impose de toute façon :
  - Build Command : `npm run build`
  - Output Directory : `dist/dyngroup-ui/browser`
  - Rewrite SPA : `/(.*)` → `/index.html` (nécessaire pour le routing Angular côté client)
- Aucune variable d'environnement nécessaire
- **Statut** : déployé

## État des KPI / endpoints API

Vérifié en interrogeant `information_schema.tables` sur les schémas `kpi` et `staging` de la base de production, croisé avec les requêtes SQL de chaque contrôleur.

### ✅ Fonctionnels (18 endpoints)

- `GET /api/okr/finance`, `/api/okr/rh`, `/api/okr/commercial`, `/api/okr/ops`, `/api/okr/dimensions` → `kpi.okr_monthly`
- `GET /api/dashboard/synthese`, `/api/dashboard/engagement`, `/api/dashboard/google-reviews` → `kpi.okr_monthly`, `staging.external_google_reviews`
- `GET /api/operationnel/dashboard` → `kpi.operationnel_*`, `staging.hr_employee`, `staging.resource_calendar`, `staging.hr_contract`, `staging.hr_leave`, `staging.hr_leave_type`, `staging.hr_leave_allocation`, `staging.account_analytic_line`, `staging.sale_order_line`
- CRUD générique (9 routes) sur `kpi.operationnel_suivi_mensuel`, `operationnel_productivite_mensuelle`, `operationnel_heures_repartition`, `operationnel_synthese_annuelle`, `operationnel_budget_employe`, `operationnel_solde_vacances`, `okr_monthly`, `okr_reference`, `staging.hr_employee`

### ❌ Cassés (4 endpoints) — module Organigramme

- `GET /api/organigram`, `/api/organigram/employees/:id/ancestors`, `/api/organigram/employees/:id/descendants`, `/api/organigram/employees/:id/tree`
- **Cause** : les tables `kpi.dim_department`, `kpi.organigram`, `kpi.dim_employee_closure` n'existent pas encore en base — jamais créées par le pipeline Airflow (contrairement à toutes les autres tables `kpi.*`).
- **Action requise** : côté pipeline ETL, créer/peupler ces 3 tables.

### ⚠️ Non vérifiés (3 endpoints)

- `GET /api/items`, `/api/clients`, `/api/commandes` — dépendent du schéma `public`, jamais interrogé. À vérifier via DBeaver ou une requête `information_schema.tables WHERE table_schema = 'public'`.

## Point de sécurité à investiguer

Une commande `node -e "require('dotenv').config()..."` exécutée en local a affiché une ligne suspecte :

```
◇ injected env (4) from .env // tip: ⌁ auth for agents [www.vestauth.com]
```

Cette chaîne (`vestauth`, `auth for agents`) a été retrouvée **dans le code source du package installé** (`node_modules/dotenv/lib/main.js`, version `17.4.2`), donc pas un artefact de terminal. Ça ressemble à une compromission de la chaîne d'approvisionnement (supply-chain attack) ciblant spécifiquement les agents IA. **Non résolu à ce jour** — l'investigation approfondie du code de `dotenv@17.4.2` (recherche d'appels réseau, exfiltration potentielle de `DATABASE_URL`/mots de passe) a été interrompue et reste à faire avant de faire confiance à cette dépendance en production.

## À faire

- [ ] Investiguer complètement le package `dotenv@17.4.2` (voir section sécurité ci-dessus)
- [ ] Créer les tables manquantes `kpi.dim_department`, `kpi.organigram`, `kpi.dim_employee_closure` (côté Airflow)
- [ ] Vérifier l'existence de `public.items`, `public.clients`, `public.commandes`
- [ ] Si l'URL Vercel de l'API change un jour, mettre à jour `dyngroup_UI/src/environments/environment.prod.ts`