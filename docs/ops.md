# Dashboard Opérations

Onglet du menu latéral intitulé **"Opérations"** (bandeau : *OPÉRATIONS — IT — PROJETS — QUALITÉ*),
distinct du dashboard **"Opérationnel"** (suivi mensuel heures/CA par collaborateur, voir
`docs/operationnel.md` si présent côté prod). Ce document couvre uniquement l'onglet Opérations.

- Frontend : `dyngroup_UI/src/app/components/ops-tab/ops-tab.component.ts` + `.html`
- Backend : `dyngroup_api/src/controllers/okr.controller.ts` (fonctions `getOpsOkr`, `getOkrDimensions`)
- Routes : `GET /api/okr/ops?annee=YYYY`, `GET /api/okr/dimensions?annee=YYYY`
- Source des données : table `kpi.okr_monthly`, alimentée par le DAG Airflow `stage3_okr`
  (`Dashboard/airflow/dags/stage3_loading/stage3_okr/dag.py`, tourne chaque nuit à 1h —
  `schedule='0 1 * * *'`)

Sept Key Results y sont affichés : **KR10, KR18, KR19, KR22, KR25, KR26, KR27**. Leurs métadonnées
(description, département propriétaire, cible, type de seuil) sont centralisées dans
`Dashboard/airflow/dags/utils/kpi_config.py` (`KEY_RESULTS`).

## Filtre

Un seul filtre : **Année** (`activeYear`, 2025 ou 2026 dans le sélecteur). Pas de filtre société,
département ou mois — tous les graphiques affichent les 12 mois de l'année sélectionnée (coupés au
mois courant si l'année en cours n'est pas terminée, via `maxMonths`).

## Comment lire ce document

Pour chaque KR : **ce qu'il mesure**, **la requête SQL qui le calcule** (dans le DAG `stage3_okr`),
**la cible et le seuil de couleur**, et **où il apparaît** dans la page.

Le calcul de couleur (`compute_status`, `Dashboard/airflow/dags/utils/kpi_calculations.py`) est
commun à tous les KR du dashboard (Finance, RH, Commercial, Ops…) :

| `threshold_type` | Règle |
|---|---|
| `absolute` | Toujours vert (pas de seuil) |
| `pct_below` | Rouge si `(valeur−cible)/\|cible\|×100 ≤ −red_delta` ; orange si `≤ −orange_delta` |
| `pct_above` | Rouge si l'écart au-dessus de la cible `≥ red_delta` (en %) ; orange si `≥ orange_delta` |
| `days_above` | Rouge si `valeur − cible ≥ red_delta` (en jours) ; orange si `≥ orange_delta` |

Ce calcul est fait côté Airflow (Python) et stocké tel quel dans `kpi.okr_monthly.status` — le
frontend ne fait qu'afficher ce statut (`getStatusBadge`/`getStatusIcon`), il ne recalcule rien.

---

## KR10 — Incidents IT / mois

- **Mesure** : nombre de tickets support créés dans le mois.
- **Source** : `staging.helpdesk_ticket`, `COUNT(*) GROUP BY TO_CHAR(create_date, 'YYYY-MM')`.
- **Cible** : pas de cible formelle dans `kpi_config.py` (`target=None`, label *"Seuil E1"*,
  commentaire *"à clarifier"*) — **5 incidents/mois** est une hypothèse de travail, câblée en dur
  à la fois dans le DAG (`_okr_row('KR10', ..., 5.0, ...)`) et dans le frontend (`limit = target('KR10') ?? 5`).
  `threshold_type = 'absolute'` → le badge de statut est **toujours vert**, quel que soit le nombre
  d'incidents ; seule la ligne pointillée rouge à 5 sur le graphique donne un repère visuel.
- **Affichage** : carte KPI (dernier mois) + graphique en barres `op-kr10`, barre rouge clair si
  `valeur > seuil`, verte sinon (logique client, indépendante du statut "absolute" toujours vert).

## KR18 — Projets déployés

- **Mesure** : nombre de tickets support **résolus** dans le mois (`close_date IS NOT NULL`) — le
  nom affiché ("Projets déployés") ne correspond pas exactement à la requête SQL, qui compte des
  tickets de support clôturés, pas des déploiements de projet au sens strict.
- **Source** : `staging.helpdesk_ticket`, `COUNT(*) GROUP BY TO_CHAR(create_date, 'YYYY-MM') WHERE close_date IS NOT NULL`.
- **Cible** : `target=None` dans `kpi_config.py` (label *"Nombre absolu"*) — le frontend affiche
  "Objectif : 4/mois" et trace une ligne cible à 4, valeur également câblée en dur côté UI
  (`objVal = target('KR18') ?? 4`), sans cible réelle définie côté ETL.
  `threshold_type = 'absolute'` → statut toujours vert.
- **Affichage** : carte KPI + graphique en barres `op-kr18` avec ligne objectif à 4.

## KR19 — Nombre d'audits internes

- **Mesure** : tâches Odoo dont le nom contient *"audit"*, rattachées à un projet dont le nom
  contient *"interne"* (couvre "Interne", "CLIENT DYN SA - INTERNE", "Support interne"). Exclut
  explicitement les tâches d'audit sur des projets clients (révisions externes, ex. "Audit 2025",
  "Hors mandat - Audit"), qui ne sont pas des audits internes.
- **Source** :
  ```sql
  SELECT TO_CHAR(t.create_date::date, 'YYYY-MM') AS month, COUNT(*) AS nb
  FROM staging.project_task t
  JOIN staging.project_project p ON p.id = t.project_id
  WHERE t.name ILIKE '%audit%' AND p.name ILIKE '%interne%'
    AND t.create_date IS NOT NULL
  GROUP BY 1
  ```
- **Cible** : 4/mois, `threshold_type = 'absolute'` → statut toujours vert malgré la cible affichée.
- **Note de cohérence** : `kpi_config.py` déclare `KR19` avec `source='external'` et le commentaire
  *"Source externe — table custom ou saisie manuelle"*, mais le DAG le calcule en réalité **depuis
  Odoo** (`staging.project_task`), pas depuis une source externe — la métadonnée `source` du KR est
  restée celle d'une version antérieure du KR, pas à jour avec son implémentation actuelle.
- **Affichage** : graphique en barres `op-kr19` (données réelles, pas de placeholder) avec ligne
  cible à 4/mois.

## KR22 — Taux de facturation vs production

- **Mesure** : part du CA produit (heures prestées valorisées) qui a effectivement été facturée
  dans le mois.
- **Source** : table intermédiaire `dwh.fact_billing_rate` (stage2, `stage2_kpi_intermediate/dag.py`,
  fonction `transform_fact_billing_rate`) :
  - Dénominateur (**production**) = `dwh.fact_production_monthly`, lui-même construit depuis
    `staging.account_analytic_line` : `production_chf = SUM(-amount)` (le coût analytique Odoo est
    négatif pour le temps presté, d'où l'inversion de signe — même convention que
    `operationnel.controller.ts`).
  - Numérateur (**facturé**) = `staging.account_move`, factures clients postées
    (`move_type='out_invoice', state='posted'`), bornées à aujourd'hui.
  - `billing_rate_pct = 100 × facturé / production` (mois par mois).
- **Cible** : 90%, `threshold_type = 'pct_below'` (orange à −2%, rouge à −5% par rapport à 90%).
- **Affichage** : graphique en courbe `op-kr22` + tableau détaillé (4 derniers mois : mois / valeur /
  cible / statut), seul KR de cette page avec un tableau de détail dans le template.

## KR25 — Production cumulée totale CHF / ETP (y compris admin) vs budget

- **Mesure** : production totale du mois (CHF, toutes heures prestées valorisées) rapportée au
  nombre total d'ETP actifs — un indicateur d'efficacité globale de l'entreprise.
- **Source** :
  ```sql
  WITH prod_emp_month AS (
      SELECT employee_id, month, SUM(production_chf) AS production_chf
      FROM dwh.fact_production_monthly GROUP BY employee_id, month
  )
  SELECT p.month, SUM(p.production_chf) AS total_production, SUM(e.etp_count) AS total_etp,
         ROUND(SUM(p.production_chf) / NULLIF(SUM(e.etp_count), 0), 2) AS prod_per_etp
  FROM prod_emp_month p
  LEFT JOIN dwh.fact_etp_monthly e ON e.month = p.month AND e.employee_id = p.employee_id
  GROUP BY p.month
  ```
  La pré-agrégation par `employee_id × month` (CTE `prod_emp_month`) avant la jointure à l'ETP est
  volontaire : `fact_production_monthly` est à la maille mois×employé×projet, une jointure directe à
  `fact_etp_monthly` (mois×employé) dupliquait l'ETP une fois par projet distinct travaillé par
  l'employé (facteur ×23 mesuré en base — voir `CORRECTIONS_KR.md` du repo Airflow).
  La ligne stockée dans `kpi.okr_monthly` pour KR25 est `total_production` (la valeur affichée, en
  CHF **total**, pas déjà divisée par l'ETP malgré le nom du KR) — c'est `prod_per_etp` qui nourrit
  KR26, pas KR25.
- **ETP** (`dwh.fact_etp_monthly`) : 8h/j × 5j = 1 ETP de référence, prorata par `resource_calendar`
  pour le temps partiel, sur les contrats actifs du mois.
- **Cible** : `target=None` (label *"Budget"*), `threshold_type='pct_below'` — sans budget réel
  saisi, le statut retombe toujours vert (`target is None` → vert, voir `compute_status`).
- **Affichage** : carte KPI (affichée en kCHF, `/ 1000` côté frontend) + graphique en courbe
  `op-kr25`, avec une ligne cible câblée en dur à 15k/ETP côté UI (`target25 = ... ?? 15`) si aucune
  cible n'est remontée par l'API.

## KR26 — Production moyenne CHF / ETP (y compris admin)

- **Mesure** : la même production/ETP que KR25, mais **ventilée par département** plutôt qu'en une
  seule valeur globale — permet de comparer l'efficacité entre équipes.
- **Source** : même calcul que KR25 (`fact_production_monthly` ÷ `fact_etp_monthly`, même
  pré-agrégation anti-duplication), mais `GROUP BY` ajoute `hr_department.name` (jointure
  `hr_employee → hr_department`), stocké en **dimension** (`dimension_key='department'`,
  `dimension_value=<nom du département>`) plutôt qu'en ligne agrégée globale.
  Les employés sans département Odoo renseigné sont regroupés sous `"Non défini"`.
- **Cible** : label *"Base 2025"*, pas de cible chiffrée publiée — même raisonnement que KR25,
  statut toujours vert.
- **Affichage** :
  - Graphique en barres `op-kr26` : une barre par département, valeur = **dernier mois disponible**
    (ou la moyenne du département si ce mois est manquant pour lui), + une ligne "Moyenne
    départements" (moyenne simple des valeurs affichées, pas pondérée par effectif).
  - Tableau sous le graphique : une ligne par département, une colonne par mois présent dans les
    données (`kr26Months`), + une colonne "Moy." (moyenne des mois non nuls de ce département).
  - Ces données viennent d'un **second appel** à l'API, `GET /api/okr/dimensions`, pas de
    `/api/okr/ops` — `getOkrDimensions` renvoie toutes les lignes à dimension non vide de
    `kpi.okr_monthly` pour l'année, et le frontend ne garde que `dimensions.KR26.department`
    (`applyKr26()`). Si cet appel échoue, la carte/graphique KR26 reste simplement vide (pas de
    blocage du reste de la page, qui dépend de `/api/okr/ops`).

## KR27 — % de tâches ouvertes (obligations trimestrielles de la fiduciaire)

- **Mesure** : part des tâches de conformité récurrente (salaires, bouclement, TVA, déclarations
  d'impôt personnes physiques/morales, audit) créées dans le mois et **encore ouvertes** à ce jour.
  Ce n'est **pas** un taux générique toutes tâches confondues : le filtre
  `QUARTERLY_COMPLIANCE_TASK_TAGS` (`kpi_config.py`) restreint aux tâches de ce périmètre précis
  (`t.name ILIKE '%<tag>%'` pour chaque tag de la liste).
- **Source** :
  ```sql
  SELECT TO_CHAR(t.create_date::date, 'YYYY-MM') AS month,
         ROUND(100.0 * COUNT(*) FILTER (WHERE COALESCE(pt.fold, FALSE) = FALSE)
                / NULLIF(COUNT(*), 0), 2) AS pct_open,
         COUNT(*) AS nb_taches
  FROM staging.project_task t
  LEFT JOIN staging.project_task_type pt ON pt.id = t.stage_id
  WHERE t.create_date IS NOT NULL AND (<filtre tags>)
  GROUP BY 1
  ```
  "Ouverte" = l'étape Kanban de la tâche n'a pas `fold = TRUE` (le marqueur Odoo standard d'une
  étape "terminée"), **pas** le champ `state` de la tâche — un commentaire du DAG signale que sur
  9081 tâches, seules 32 avaient un `state='1_done'` renseigné : l'équipe fait avancer les tâches
  dans les colonnes Kanban mais ne touche quasiment jamais ce champ `state`, ce qui le rend
  inutilisable comme critère de clôture.
- **⚠️ Hypothèse non validée** (signalée explicitement dans le DAG) : si aucune étape Kanban de ce
  projet n'a `fold=TRUE` dans cette instance Odoo, `pct_open` reste à 100% en permanence, comme
  l'ancien calcul avant cette correction — à vérifier avec l'équipe fiduciaire que les bonnes étapes
  Kanban sont bien marquées "pliées" (fold) dans Odoo.
- **Cible** : 20% max, `threshold_type='pct_above'` (orange à +5%, rouge à +10% au-dessus de 20%).
- **Affichage** : carte KPI (dernier mois) + graphique en barres `op-kr27`, axe Y borné à 0–100%.

---

## Parenté avec le dashboard Finance

KR27 et KR19 étaient auparavant évoqués comme partagés avec le dashboard Finance (propriétaire
organisationnel "Sandrine"/"Zlatan" selon `kpi_config.py`), mais leur **affichage** se fait
exclusivement ici, dans l'onglet Opérations — contrairement à **KR12**, qui a été déplacé du
dashboard Finance vers l'onglet **Indicateurs Clés** du dashboard **Opérationnel** (pas Opérations),
le 2026-10-05 (voir `docs/export-excel-kpi.md`/historique git pour ce changement). KR12 est calculé
par ce même DAG `stage3_okr` (proxy "projet archivé = rapport livré", délai `write_date − date_start`,
cible J+10) **mais plus affiché depuis cette table côté dashboard** : `operationnel.controller.ts`
recalcule la même métrique directement depuis `staging.project_project`, filtrée sur l'année choisie
dans le dashboard Opérationnel, plutôt que de lire `kpi.okr_monthly`.

## Gestion des erreurs côté frontend

Si `/api/okr/ops` échoue (timeout 8s, ou erreur HTTP), `ops-tab.component.ts` affiche un bandeau
d'erreur (*"Connexion à la base de données indisponible"*) et laisse tous les graphiques/cartes
vides (`—`). Un ancien mécanisme de **repli sur des données fictives** (`buildFallbackSeries()`,
avec des départements inventés comme "Tech & Dev"/"Ops & IT") a été désactivé et laissé en
commentaire dans le code — jugé trompeur pour l'utilisateur, qui pourrait confondre ces chiffres
inventés avec de vraies données.
