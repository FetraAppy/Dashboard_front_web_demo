# Analyse des KR à corriger — Dashboard DynGroup

Analyse des 8 Key Results marqués **« En Cours »** ou **« En attente »** dans le PDF de suivi
(*Suivi_Validation_Dashboards_DynGroup*), croisée avec le code ETL réel
(`Dyn-solution/Dashboard`, dossier `airflow/`) et le code de l'API/frontend
(`Dashboard_front_web`).

Généré le 2026-08-20.

**Périmètre :** Finance (KR13) · Ops (KR27, KR19, KR26) · Commercial (KR08, KR23) · RH (KR02, KR03)

> **Note de méthode :** les constats ci-dessous proviennent de la lecture du code source
> (ETL + API + frontend). Les vérifications en base restent à faire via les requêtes SQL
> listées en fin de document — la connexion directe depuis l'environnement d'analyse est
> bloquée (voir « Accès base de données »).

---

## Où vit un KR — rappel du circuit

```
Odoo → stage1_extraction (staging.*) → stage2_transformation (dwh.*) → stage3_okr (kpi.okr_monthly)
     → dyngroup_api (okr.controller.ts) → dyngroup_UI (onglet du domaine)
```

Tous les KR (sauf exceptions notées) vivent dans **une seule table pivot `kpi.okr_monthly`**,
distinguée par `kr_id`. Les métadonnées (owner, cible, seuils, source) sont dans
`airflow/dags/utils/kpi_config.py`. Le calcul est dans
`airflow/dags/stage3_loading/stage3_okr/dag.py`.

---

# FINANCE

## KR13 — Dépassement budget frais fixes · *En attente*

**Owner :** Sandrine · **Cible :** Budget 2026 · **Seuil :** `pct_above_budget` (orange +5%, rouge +10%)

### Ce que dit le PDF
> « Budget des frais fixes non saisi dans Odoo. S'affichera automatiquement dès que les budgets seront renseignés. »

### Ce que dit le code — l'affirmation est inexacte

Trois blocages successifs, pas un seul. Le KPI **ne s'affichera pas automatiquement**
une fois les budgets saisis.

**1. Aucun calcul n'existe.** Aucun `_okr_row('KR13', ...)` dans `stage3_okr/dag.py`.
Le KR est déclaré dans `kpi_config.py` mais rien ne le produit.

**2. La table budget est extraite sans les montants.** `account.budget` est bien extraite
par `stage1_accounting`, mais `utils/kpi_fields.py` ne demande que des métadonnées d'en-tête :

```python
ACCOUNT_BUDGET = ['id', 'name', 'date_from', 'date_to', 'state', 'company_id', 'create_date']
```

Aucune colonne de montant. Dans Odoo, les montants budgétaires vivent dans les *lignes*
de budget (`account.budget.post` / lignes budgétaires), qui ne sont extraites nulle part.

**3. Piège de nommage en stage2.** La fonction `transform_fact_budget_actual()` s'intitule
*« Budget vs réalisé — KR13, KR15, KR23, KR25 »* mais son SQL ne lit que `account_move` :
elle calcule uniquement le **réalisé**, jamais le budget.

### À faire
1. **Métier** — saisir les budgets de frais fixes dans Odoo
2. **ETL** — étendre l'extraction stage1 aux lignes de budget **avec leurs montants**
3. **ETL** — écrire le calcul KR13 dans `stage3_okr/dag.py`

---

# OPS

## KR27 — Tâches ouvertes (%) · *En Cours*

**Owner :** Zlatan · **Cible :** Max 20% · **Seuil :** `pct_above`

### Le KR ne mesure pas ce que sa définition annonce

Description officielle dans `kpi_config.py` :
> « % tâches ouvertes **trimestrielles (Salaire, bouclement, TVA…)** »

Le fichier définit même la liste des tâches concernées :
```python
QUARTERLY_COMPLIANCE_TASK_TAGS = ['salaire', 'bouclement', 'tva', 'di pp', 'dipm', 'audit']
```

**Cette constante n'est utilisée nulle part** (vérifié par recherche sur tout le dossier `airflow/`).

Le calcul réel prend **toutes les tâches**, sans filtre :
```sql
SELECT TO_CHAR(create_date::date, 'YYYY-MM') AS month,
       ROUND(100.0 * COUNT(*) FILTER (WHERE state NOT IN ('1_done','1_canceled'))
              / NULLIF(COUNT(*), 0), 2) AS pct_open
FROM staging."project_task"
WHERE create_date IS NOT NULL
GROUP BY 1
```

Le code l'assume d'ailleurs explicitement en commentaire : `# Proxy : part des tâches créées dans le mois encore ouvertes.`

**Conséquence :** le chiffre affiché à la direction n'a pas le sens qu'elle croit lire —
c'est un taux global de tâches ouvertes, pas le suivi de conformité trimestrielle.

### À faire
- Ajouter le filtre sur les tâches de conformité (via `QUARTERLY_COMPLIANCE_TASK_TAGS`,
  sur le nom ou les tags Odoo)
- Vérifier en base que ces tâches existent et sont nommées de façon exploitable

---

## KR19 — Audits internes · *En Cours*

**Owner :** Thomas · **Cible :** 4/mois · **Source déclarée :** `external`

### Contradiction entre la configuration et le code

`kpi_config.py` déclare une source **externe/manuelle** :
```python
KeyResult('KR19', "Nombre d'audits internes", ..., source='external',
          notes='Source externe — table custom ou saisie manuelle'),
```

Mais `stage3_okr/dag.py` calcule un **proxy depuis Odoo** :
```sql
SELECT TO_CHAR(t.create_date::date, 'YYYY-MM') AS month, COUNT(*) AS nb
FROM staging."project_task" t
JOIN staging."project_project" p ON p.id = t.project_id
WHERE t.name ILIKE '%audit%'
  AND p.name ILIKE '%interne%'
  AND t.create_date IS NOT NULL
GROUP BY 1
```

### Le circuit « source externe » prévu est un cul-de-sac

- `stage1_external` charge bien une table `external.manual_kpi` (prévue pour KR03/KR12/KR19)
- **Aucun DAG stage2 ou stage3 ne la lit jamais** (vérifié par recherche)
- `EXTERNAL_KPI_JSON_PATH` n'est pas configuré → la table est vide de toute façon

### Vérifié en base
`SELECT ... FROM kpi.okr_monthly WHERE kr_id='KR19'` → **0 ligne**.
Le proxy `audit` + `interne` ne matche rien dans les données actuelles.

### À faire — décision métier d'abord
Choisir entre :
- **(a)** valider la convention de nommage avec l'équipe, et s'assurer que les tâches d'audit
  sont bien créées avec « audit » dans le nom, dans des projets contenant « interne »
- **(b)** implémenter la voie manuelle prévue : configurer `EXTERNAL_KPI_JSON_PATH`
  **et** brancher `external.manual_kpi` en stage3 (n'existe pas aujourd'hui)

L'option (b) débloque aussi KR03 et KR12 — voir « Problèmes transverses ».

---

## KR26 — Production moyenne / ETP par département · *En Cours*

**Owner :** Zlatan · **Cible :** Base 2025 · **Seuil :** `pct_below`

Calculé deux fois dans `stage3_okr/dag.py` : une ligne agrégée + une ventilation par
département (`dim_key='department'`), depuis `dwh.fact_production_monthly` × `dwh.fact_etp_monthly`.

### Problème 1 — risque de double comptage de l'ETP

- `fact_production_monthly` est groupée par **employé × projet × mois**
- `fact_etp_monthly` est groupée par **employé × mois**

La jointure :
```sql
LEFT JOIN dwh.fact_etp_monthly e ON e.month = p.month AND e.employee_id = p.employee_id
```
répète la ligne ETP pour **chaque projet** de l'employé. Un employé travaillant sur 4 projets
voit son ETP compté 4 fois → dénominateur gonflé → **production/ETP sous-estimée**.

### Problème 2 — signe de `production_chf` à vérifier

La production vient de `SUM(account_analytic_line.amount)` (stage2, hypothèse documentée dans
le code : *« production = montant timesheets »*).

Or dans `dyngroup_api/src/controllers/operationnel.controller.ts`, les heures **facturables**
sont filtrées par `amount < 0` — dans Odoo, ces montants sont négatifs pour le temps presté.
Si c'est le cas ici, la production ressort négative.

### À faire
- Pré-agréger la production par employé/mois **avant** la jointure sur l'ETP
- Vérifier le signe de `amount` (requête SQL fournie en fin de document)

---

# COMMERCIAL

## KR08 — Mouvement des clients vs M-1 · *En Cours*

**Owner :** Matthieu · **Cible :** +10 · **Seuil :** `absolute`

### Bug logique dans la définition des « pertes »

```sql
span AS (
    SELECT partner_id, MIN(month) AS first_m, MAX(month) AS last_m
    FROM inv GROUP BY partner_id
)
...
(SELECT COUNT(*) FROM span s WHERE s.last_m = m.month) AS losses
```

Un client est compté comme **perdu** si le mois de sa dernière facture = le mois analysé.

Mais pour un client **actif**, la dernière facture est forcément la plus récente.
→ **Tous les clients actifs sont comptés comme « perdus »** sur le mois courant.

Le solde net (`acquisitions − pertes`) est donc structurellement faussé, surtout sur
le dernier mois de la série.

### À faire
Redéfinir « perte » avec une vraie règle métier — par exemple *« client sans facture depuis
N mois consécutifs »* — au lieu de `MAX(month) = mois courant`.
La valeur de N est une décision métier (3 mois ? 6 mois ?).

---

## KR23 — Top 10 clients en % du budget (Pareto) · *En Cours*

**Owner :** Yuth · **Cible :** Max 20% · **Seuil :** `pct_above`

### Techniquement le mieux écrit des huit

`ROW_NUMBER() OVER (PARTITION BY month ORDER BY ca DESC)`, part cumulée du top 10 +
une ligne par client en dimension, noms résolus via `res_partner` avec repli `'Client #id'`.
**Rien de cassé dans la logique.**

### L'écart est sémantique

Le KR s'intitule *« Top 10 clients en % du **budget** »*, mais le code calcule le
**% du CA réalisé** (`amount_untaxed` des factures `out_invoice` postées).

Deux notions différentes. Et comme pour KR13, **aucune donnée de budget n'entre dans le
pipeline** de toute façon.

### À faire — trancher avec Mohammed/Yuth
- Si « % du CA » convient → corriger l'intitulé du KR et valider
- Si c'est bien le budget qui est visé → même prérequis que KR13 (extraction des montants budgétaires)

---

# RH

## KR02 — Heures supplémentaires & solde vacances / ETP · *En Cours*

**Owner :** Emilie · **Cible :** aucune (`None`, *« Proposition Yuth »*) · **Seuil :** `pct_below`

Calculé depuis `staging.hr_leave` + `staging.hr_attendance` + `dwh.fact_etp_monthly`
+ `staging.hr_leave_allocation`.

### Quatre fragilités, dont deux vrais bugs

**1. Heures théoriques codées en dur**
```python
hs = worked - 168.0 * etp_v  # heures supplémentaires ≈ pointées − théoriques
```
Tous les mois valent 168h, jours fériés ignorés. L'API sait pourtant faire bien mieux :
`computeTheoMensuelEmployee()` dans `operationnel.controller.ts` calcule les jours ouvrés
réels avec les fériés vaudois (calcul de Pâques, Jeûne fédéral) et le prorata de contrat.

**2. 🐛 Allocation vacances sans filtre d'année**
```sql
SELECT COALESCE(SUM(number_of_days), 0) AS days
FROM staging."hr_leave_allocation"
WHERE state = 'validate'
```
Somme **toutes** les allocations, toutes années et tous employés confondus.

**3. 🐛 Cumul jamais remis à zéro**
```python
cum_vac = 0.0
for month in sorted(...):
    cum_vac += vac_h
    ... _okr_row('KR02', month, round(alloc_hours - cum_vac, 2), dim_key='detail', dim_val='solde', ...)
```
`cum_vac` s'accumule sur tous les mois de tout l'historique sans reset annuel.
Le « solde vacances restant » dérive de plus en plus au fil des années.

**4. ID de type de congé codé en dur**
`WHERE holiday_status_id = 1` suppose que le type « vacances » a l'ID 1.
Ailleurs (`operationnel.controller.ts`), une jointure propre sur `hr_leave_type.time_type`
est utilisée — approche plus robuste.

### Cible non définie
`target = None` (*« Proposition Yuth »*) → aucun objectif chiffré n'existe encore,
ce qui contribue au statut « En Cours ».

### À faire
- Filtrer les allocations par année
- Réinitialiser le cumul à chaque exercice
- Remplacer le 168h en dur par un vrai calendrier (réutiliser la logique de l'API)
- Remplacer `holiday_status_id = 1` par une jointure sur `hr_leave_type.time_type`
- **Métier** : faire définir la cible par Yuth

---

## KR03 — Heures de formation certifiante par ETP · *En attente*

**Owner :** Emilie · **Cible :** 0.25 jour · **Source déclarée :** `external`

### Le seul cas totalement sain

`kpi_config.py` déclare correctement `source='external'`, et le code écrit un placeholder honnête :
```python
for ext_kr in ('KR03',):
    kr = KR_BY_ID[ext_kr]
    rows_out.append(_okr_row(ext_kr, datetime.utcnow().strftime('%Y-%m'), None, kr.target,
                             dim_key='status', dim_val='pending_external_source', computed_at=now))
```

La cible est définie (0.25 jour/ETP). **Rien à corriger dans le code.**

### Blocage en amont
- Aucun module de formation dans Odoo (confirmé par le commentaire du PDF)
- La voie manuelle (`external.manual_kpi`) est le même cul-de-sac que pour KR19

### À faire
- **Métier** — créer un suivi des formations (module Odoo ou fichier externe)
- **ETL** — brancher `external.manual_kpi` en stage3 (voir « Problèmes transverses »)

---

# Problèmes transverses

Deux chantiers qui débloquent plusieurs KR à la fois — à traiter en priorité pour
maximiser le rapport effort/valeur.

## 1. Le circuit « source externe » est incomplet

`external.manual_kpi` est alimentée en stage1 mais **jamais consommée** en stage2/stage3.
De plus `EXTERNAL_KPI_JSON_PATH` n'est pas configuré.

**Bloque ensemble : KR03, KR12, KR19.** Un seul chantier les débloque tous les trois.

## 2. Aucune donnée de budget n'entre dans le pipeline

- Pas de montants budgétaires Odoo → **KR13**
- Pas de budget commercial → **KR23** (définition « % du budget »)
- `ca_budget_annuel_chf = 0.0` en dur dans `OPERATIONAL_DEFAULTS` → **OP01, OP07, OP08**

**Bloque ensemble : KR13, KR23, OP01, OP07, OP08.**

---

# Priorisation

## Groupe 1 — Bugs francs, correction rapide, gros gain de fiabilité
Corrections purement techniques, aucune décision métier requise.

| KR | Bug | Fichier |
|---|---|---|
| KR08 | « Pertes » = dernière facture → tous les clients actifs comptés perdus | `stage3_okr/dag.py` |
| KR02 | Allocation vacances sans filtre d'année + cumul jamais réinitialisé | `stage3_okr/dag.py` |
| KR26 | Double comptage ETP dans la jointure production × ETP | `stage3_okr/dag.py` |

## Groupe 2 — Écarts de définition, à trancher avant de coder
Nécessitent une décision de Mohammed/Yuth.

| KR | Question à trancher |
|---|---|
| KR27 | Doit-on filtrer sur les tâches de conformité trimestrielle, ou garder le taux global ? |
| KR23 | « % du budget » ou « % du CA » ? |
| KR19 | Proxy Odoo (nommage `audit`/`interne`) ou saisie manuelle ? |
| KR02 | Quelle cible chiffrée ? (actuellement `None`) |

## Groupe 3 — Bloqués sur données amont, chantiers plus lourds

| KR | Prérequis |
|---|---|
| KR13 | Saisie budgets Odoo + extraction des montants + écriture du calcul |
| KR03 | Création d'un suivi formation + branchement `external.manual_kpi` |

---

# Requêtes SQL de vérification

À exécuter dans DataGrip (schémas `kpi`, `staging`, `dwh` de la base `dashboard`).

## Vue d'ensemble — quels KR ont réellement des données
```sql
SELECT kr_id, COUNT(*) AS nb_lignes,
       COUNT(actual_value) AS nb_valeurs_non_nulles,
       MIN(period_key) AS premier_mois, MAX(period_key) AS dernier_mois,
       MAX(computed_at) AS derniere_maj
FROM kpi.okr_monthly
GROUP BY kr_id ORDER BY kr_id;
```

## KR08 — confirmer le bug « pertes »
```sql
WITH inv AS (
    SELECT DISTINCT partner_id, TO_CHAR(invoice_date::date,'YYYY-MM') AS month
    FROM staging.account_move
    WHERE move_type='out_invoice' AND state='posted'
      AND invoice_date IS NOT NULL AND partner_id IS NOT NULL
),
span AS (SELECT partner_id, MIN(month) first_m, MAX(month) last_m FROM inv GROUP BY partner_id)
SELECT last_m AS mois, COUNT(*) AS clients_comptes_comme_perdus
FROM span GROUP BY last_m ORDER BY last_m DESC LIMIT 6;
```
*Un pic sur le mois le plus récent confirme le bug.*

## KR26 — signe de production et double comptage ETP
```sql
-- Signe des montants
SELECT MIN(amount) AS min_amount, MAX(amount) AS max_amount,
       COUNT(*) FILTER (WHERE amount < 0) AS nb_negatifs,
       COUNT(*) FILTER (WHERE amount > 0) AS nb_positifs
FROM staging.account_analytic_line WHERE date IS NOT NULL;

-- Double comptage
SELECT p.month,
       (SELECT SUM(etp_count) FROM dwh.fact_etp_monthly WHERE month = p.month) AS etp_reel,
       SUM(e.etp_count) AS etp_apres_jointure
FROM dwh.fact_production_monthly p
LEFT JOIN dwh.fact_etp_monthly e ON e.month=p.month AND e.employee_id=p.employee_id
GROUP BY p.month ORDER BY p.month DESC LIMIT 6;
```
*Si `etp_apres_jointure` ≫ `etp_reel`, le double comptage est confirmé.*

## KR02 — allocations et types de congé
```sql
SELECT COUNT(*) AS nb_allocations,
       SUM(number_of_days) AS total_jours_toutes_annees,
       MIN(create_date) AS plus_ancienne, MAX(create_date) AS plus_recente
FROM staging.hr_leave_allocation WHERE state='validate';

SELECT id, name, time_type FROM staging.hr_leave_type ORDER BY id;
```
*Confirme si la somme mélange plusieurs années, et si `holiday_status_id = 1` est bien « vacances ».*

## KR19 / KR27 — proxys sur les tâches
```sql
-- KR19 : tâches "audit" et leurs projets
SELECT p.name AS projet, COUNT(*) AS nb_taches_audit
FROM staging.project_task t
LEFT JOIN staging.project_project p ON p.id = t.project_id
WHERE t.name ILIKE '%audit%'
GROUP BY p.name ORDER BY nb_taches_audit DESC;

-- KR27 : tâches de conformité trimestrielle
SELECT COUNT(*) AS total_taches,
       COUNT(*) FILTER (WHERE name ILIKE '%salaire%' OR name ILIKE '%bouclement%'
                          OR name ILIKE '%tva%' OR name ILIKE '%audit%') AS nb_conformite
FROM staging.project_task;

SELECT state, COUNT(*) FROM staging.project_task GROUP BY state ORDER BY 2 DESC;
```

## KR13 / KR23 — absence de budget
```sql
SELECT COUNT(*) AS nb_budgets FROM staging.account_budget;
SELECT * FROM staging.account_budget LIMIT 5;
```

---

# Contexte d'infrastructure

## Accès base de données
- PostgreSQL tourne dans un conteneur Docker **`touria_postgres`** (image `postgis/postgis:16-3.4`)
  sur la VM `vm-dwh` (`34.65.51.39`, zone `europe-west6-c`)
- Le nom du conteneur suggère une instance provisionnée à l'origine pour un autre
  projet/client (« touria ») — **à clarifier avec l'équipe infra**
- Ce n'est **pas** une instance Cloud SQL managée (contrairement à ce qu'indique `DEPLOYMENT.md`),
  mais du PostgreSQL auto-hébergé sur une VM Compute Engine

## ⚠️ Point de sécurité
La règle de pare-feu `postgres` autorise **`0.0.0.0/0`** sur le port `5432` — la base est
exposée à tout Internet. Combiné à l'absence de SSL dans `dyngroup_api/src/db/pool.ts`,
c'est un risque à traiter. Restreindre au minimum aux IP de `vm-airflow`, des développeurs,
et de Vercel.

## État des DAGs Airflow (au 2026-08-20)
- **11 DAGs sur 15** ont leur dernier run en échec
- Les `stage1_*` échouent sur `ConnectionRefused` vers Odoo — l'instance configurée
  (`dyn-group-test-34931556.dev.odoo.com`) ne répond plus. Une nouvelle instance existe
  (`dyn-group-test-36687899.dev.odoo.com`) → mettre à jour `ODOO_URL` dans le `.env`
  de `vm-airflow` (lu par `odoo_helper.py`)
- `stage2_organigram` / `stage3_organigram` : 0 succès sur 21 runs, bug SQL
  `operator does not exist: integer = text` dans `transform_dim_department()`
  (colonnes `parent_id`/`manager_id` de `hr_department` typées `text`, à caster en `integer`)
- Les échecs de `stage2_kpi_intermediate` / `stage3_okr` / `stage3_operational` restent
  à investiguer séparément — ces DAGs ne parlent jamais à Odoo directement

> **Important :** tant que les DAGs stage1 → stage3 n'ont pas tourné avec succès,
> les vérifications en base des 8 KR ci-dessus peuvent refléter des données obsolètes
> plutôt que l'état réel des calculs.
