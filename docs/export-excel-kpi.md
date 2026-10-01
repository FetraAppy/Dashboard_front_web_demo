# Export Excel des KPI — Base technique

Documentation de la base commune qui permet d'exporter un KPI du dashboard en fichier Excel (`.xlsx`), avec les filtres actifs du dashboard. Cette base ne contient encore aucun KPI : chaque KPI s'y branche ensuite un par un (voir [Ajouter un KPI](#ajouter-un-kpi)).

> État actuel : implémenté dans `Dashboard_front_web_demo`, pas encore porté en prod.

---

## Sommaire

1. [Objectif](#objectif)
2. [Installation](#installation)
3. [Vue d'ensemble](#vue-densemble)
4. [Structure du classeur généré](#structure-du-classeur-généré)
5. [API d'export](#api-dexport)
6. [Filtres et périmètre](#filtres-et-périmètre)
7. [Fichiers de la base](#fichiers-de-la-base)
8. [Contrat d'un export (types)](#contrat-dun-export-types)
9. [Helpers du générateur](#helpers-du-générateur)
10. [Ajouter un KPI](#ajouter-un-kpi)
11. [Côté frontend](#côté-frontend)
12. [Contraintes et points d'attention](#contraintes-et-points-dattention)
13. [Tester](#tester)

---

## Objectif

Sur chaque KPI du dashboard (carte, graphique, tableau), un bouton **Excel** télécharge un classeur qui contient :

- la fiche du KPI : titre, description, métier, formule, cible, sources Odoo, tables, commentaires ;
- les filtres actifs du dashboard au moment du clic (collaborateur, sociétés, année, mois) ;
- le **chemin de calcul** sous forme d'arbre : de quelle source on part, quels filtres on applique, quelle opération donne la valeur ;
- les **données brutes ligne par ligne** qui ont servi au calcul (ex. chaque ligne de timesheet), réparties sur une ou plusieurs feuilles.

L'export utilise les mêmes requêtes et le même périmètre que le dashboard : les chiffres de l'Excel doivent être identiques à ceux affichés.

---

## Installation

La librairie utilisée est [ExcelJS](https://github.com/exceljs/exceljs) (licence MIT), côté API uniquement. Rien à installer côté Angular : le fichier est généré par l'API, le navigateur ne fait que le télécharger.

| Environnement | Action |
|---|---|
| Démo | Fait : `exceljs` 4.4.0 dans `Dashboard_front_web_demo/dyngroup_api/package.json` |
| Prod | Dans `Dashboard_front_web/dyngroup_api` : `npm install exceljs`, puis commiter `package.json` et `package-lock.json` |

L'API de prod tourne sur Vercel (`dyngroup-api.vercel.app`) : Vercel installe automatiquement les dépendances de `package.json` au déploiement, aucune autre étape n'est nécessaire.

**Pourquoi ExcelJS plutôt que SheetJS (`xlsx`)** : la version gratuite de SheetJS ne permet pas la mise en forme (gras, couleurs, bordures) ni le regroupement de lignes dépliable, deux éléments nécessaires ici. ExcelJS couvre les deux, gère plusieurs feuilles, les vraies formules Excel et les gros volumes.

**Alertes `npm audit`** : ExcelJS embarque deux dépendances signalées (`uuid` et `brace-expansion`, via `archiver`). Elles ne sont atteignables qu'avec des entrées utilisateur passées à ces fonctions, ce que notre code ne fait jamais. Elles sont laissées telles quelles.

---

## Vue d'ensemble

Le flux d'un export, du clic au fichier :

```
[Bouton Excel sur un KPI]  (frontend)
   │  kpiId + filtres actifs (exportParams)
   ▼
KpiExportService.download()
   │  GET /api/operationnel/export/:kpiId?annee=…&mois=…&collab=…&companies=…
   ▼
exportOperationnelKpi()  (contrôleur API)
   ├─ parseOperationnelFilters()   lit et valide les filtres
   ├─ resolveEmployeeScope()       employés + période, comme le dashboard
   ├─ OPERATIONNEL_KPI_EXPORTERS[kpiId](filtres, périmètre)
   │     └─ exporteur du KPI : requêtes staging.* → KpiExport
   ├─ buildKpiWorkbook()           KpiExport → classeur ExcelJS
   └─ sendWorkbook()               .xlsx renvoyé en téléchargement
   ▼
Le navigateur télécharge le fichier
```

La base (types, générateur, filtres, route, bouton) est commune. Seul l'exporteur est propre à chaque KPI.

---

## Structure du classeur généré

Tous les exports ont la même structure.

### Feuille « Informations »

| Zone | Contenu |
|---|---|
| **A1** | Titre « Informations » |
| **Filtres appliqués** | Collaborateur, Société(s), Année, Mois, Période couverte, Exporté le |
| **Indicateur** | Titre, Onglet du dashboard, Description, Métier, Formule, Cible (si définie), Source Odoo, Tables BDD, Commentaires (si définis), Feuilles de données (liste des onglets de données avec leur description) |
| **Données** | Titre « Données », puis le tableau du chemin de calcul : colonnes **Étape / Valeur / Détail** |

Dans les zones Filtres et Indicateur, le libellé est en colonne A et la valeur est fusionnée sur les colonnes B:C.

**Le chemin de calcul** est un arbre :

- chaque étape est une ligne ;
- les étapes enfants sont indentées et préfixées par `└` ;
- les lignes sont regroupées avec la fonction de plan d'Excel : on peut replier ou déplier chaque branche avec les boutons +/− dans la marge ;
- la racine (en gras) porte la valeur du KPI, idéalement sous forme de formule Excel qui se recalcule depuis les feuilles de données.

Exemple de rendu (arbre fictif, pour illustrer la forme) :

| Étape | Valeur | Détail |
|---|---|---|
| **H. Productivité** | **=SUM('Timesheets productives'!$C$2:$C$310)** | |
| └ Source | | Feuilles de temps |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Filtre | | Productivité = Oui |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Filtre | | Hors lignes fériés fictives |
| └ Opération | | Σ colonne Heures |

### Feuilles de données

Une feuille par jeu de données brutes (ex. « Timesheets productives ») :

- ligne 1 : en-têtes, en gras, figée (reste visible en défilant) ;
- filtre automatique sur les en-têtes ;
- données à partir de la ligne 2, une ligne par enregistrement source ;
- format par colonne (date, décimales) défini par l'exporteur.

### Nom du fichier

`<kpiId>_<année>_<collaborateur ou tous-collaborateurs>_<mois ou tous-mois>[_<sociétés>].xlsx`

Exemple : `h-productivite_2026_AGACHII-Igor_tous-mois.xlsx`. Les accents et caractères spéciaux sont retirés.

---

## API d'export

```
GET /api/operationnel/export/:kpiId
```

| Paramètre | Obligatoire | Valeurs | Sens |
|---|---|---|---|
| `kpiId` (chemin) | oui | identifiant enregistré dans le registre | KPI à exporter |
| `annee` | oui | entier entre 2000 et 2100 | Année du dashboard |
| `mois` | non (défaut `all`) | `all` ou `1` à `12` | Mois sélectionné ; `all` = janvier à décembre |
| `collab` | non (défaut `all`) | `all` ou nom exact du collaborateur | Filtre collaborateur |
| `companies` | non | nom de société, **répétable** | Sociétés cochées ; absent = toutes |

Exemple :

```
/api/operationnel/export/h-productivite?annee=2026&mois=all&collab=AGACHII%20Igor&companies=DYN%20SA
```

### Réponses

| Code | Cas | Corps |
|---|---|---|
| 200 | Succès | Le fichier `.xlsx` (en-tête `Content-Disposition` avec le nom du fichier) |
| 400 | Filtre invalide (année, mois) ou collaborateur absent du périmètre | `{ "error": "<message>" }` |
| 404 | `kpiId` non enregistré | `{ "error": "Export inconnu : <kpiId>" }` |
| 413 | Fichier généré trop gros pour Vercel | `{ "error": "Export trop volumineux — réduisez la période ou filtrez sur un collaborateur/une société." }` |
| 500 | Erreur inattendue (requête SQL, génération) | `{ "error": "Erreur lors de la génération de l'export Excel" }` — le détail est dans les logs serveur |

---

## Filtres et périmètre

Fichier : `dyngroup_api/src/export/operationnel/export-filters.ts`.

### `parseOperationnelFilters(query)`

Lit les paramètres de la requête et renvoie :

```ts
interface OperationnelExportFilters {
  annee: number;
  mois: number | null;      // 1-12, ou null = tous les mois
  collab: string | null;    // nom exact, ou null = tous
  companies: string[];      // vide = toutes les sociétés
}
```

Lève une `ExportFilterError` (→ réponse 400) si l'année ou le mois est invalide.

### `resolveEmployeeScope(filtres)`

Reproduit exactement le périmètre du dashboard :

1. **Univers d'employés** : les employés présents dans `kpi.operationnel_suivi_mensuel` pour l'année, joints à `staging.hr_employee` (même requête de base que le dashboard).
2. **Société** : via `staging.res_company` (nom de la société de l'employé), comme le filtre Société du dashboard.
3. **Filtre sociétés** : on garde les employés dont la société fait partie des sociétés cochées.
4. **Filtre collaborateur** : on garde l'employé dont le nom correspond exactement. S'il n'est pas dans le périmètre → `ExportFilterError` (400).
5. **Période** : `mois = null` → du 1er janvier au 31 décembre ; sinon, du 1er au dernier jour du mois.

Renvoie :

```ts
interface EmployeeScope {
  employees: { id: number; name: string; company: string | null }[];
  employeeIds: number[];   // à utiliser dans les requêtes : employee_id = ANY($1::int[])
  dateFrom: string;        // YYYY-MM-DD, inclus
  dateTo: string;          // YYYY-MM-DD, inclus
  months: number[];        // mois couverts (1-12)
}
```

### `describeFilters()` et `filtersSlug()`

- `describeFilters()` produit les lignes du bloc « Filtres appliqués » de la feuille Informations.
- `filtersSlug()` produit la partie du nom de fichier décrivant les filtres.

---

## Fichiers de la base

### Backend (`dyngroup_api/src/`)

| Fichier | Rôle |
|---|---|
| `export/excel/kpi-export.types.ts` | Contrat commun d'un export (types) |
| `export/excel/workbook-builder.ts` | Construit le classeur, helpers, envoi HTTP |
| `export/operationnel/export-filters.ts` | Lecture des filtres et calcul du périmètre |
| `export/operationnel/kpi-registry.ts` | Registre des exporteurs de KPI (vide pour l'instant) |
| `export/operationnel/kpis/` | À créer : un fichier par KPI |
| `controllers/operationnel-export.controller.ts` | Contrôleur de la route d'export |
| `routes/operationnel.routes.ts` | Route `GET /export/:kpiId` ajoutée |

### Frontend (`dyngroup_UI/src/app/`)

| Fichier | Rôle |
|---|---|
| `shared/kpi-export.service.ts` | Appelle l'API et déclenche le téléchargement |
| `shared/export-button/export-button.{ts,html,css}` | Bouton « ⬇ Excel » réutilisable |
| `components/operationnel-dashboard/operationnel-dashboard.component.ts` | Getter `exportParams` (filtres actifs au format de l'API) |

---

## Contrat d'un export (types)

Fichier : `dyngroup_api/src/export/excel/kpi-export.types.ts`. Chaque exporteur renvoie un `KpiExport` :

```ts
interface KpiExport {
  definition: KpiDefinition;     // fiche du KPI
  derivation: DerivationNode[];  // chemin de calcul (arbre)
  sheets: DataSheet[];           // données brutes
}
```

### `KpiDefinition`

| Champ | Obligatoire | Contenu |
|---|---|---|
| `id` | oui | Identifiant du KPI (même valeur que la clé du registre, sert aussi au nom du fichier) |
| `titre` | oui | Nom affiché dans le dashboard |
| `onglet` | oui | « Indicateurs Clés » ou « Suivi Mensuel & Détails » |
| `description` | oui | Ce que mesure le KPI |
| `metier` | oui | Sa signification métier |
| `formule` | oui | Formule en noms métier (reprendre `docs/operationnel-kpi-details.md`) |
| `cible` | non | Cible / seuils |
| `sourceOdoo` | oui | Où la donnée se trouve dans Odoo |
| `tables` | oui | Tables `staging.*` interrogées |
| `commentaires` | non | Nuances, exceptions, corrections passées (une entrée par ligne) |

### `DerivationNode` (une étape de l'arbre)

| Champ | Contenu |
|---|---|
| `label` | Nom de l'étape (colonne Étape) : ex. « Source », « Filtre », « Opération » |
| `detail` | Explication (colonne Détail) : ex. « Productivité = Oui » |
| `value` | Valeur affichée (colonne Valeur) |
| `formula` | Formule Excel à la place de `value` (voir ci-dessous) ; si `value` est aussi renseignée, elle sert de résultat affiché avant recalcul |
| `numFmt` | Format Excel de la valeur, ex. `'0.00'` |
| `children` | Étapes enfants |

La **racine** porte la valeur du KPI. Si un KPI a plusieurs valeurs (ex. une valeur par mois ou par catégorie), `derivation` peut contenir plusieurs racines.

### `DataSheet` (une feuille de données)

| Champ | Contenu |
|---|---|
| `name` | Nom de l'onglet (31 caractères max, les caractères `[]:*?/\` sont remplacés automatiquement) |
| `description` | Rappelée dans la feuille Informations |
| `columns` | `{ header, key, width?, numFmt? }[]` : en-tête affiché, clé dans les lignes, largeur, format |
| `rows` | Tableau d'objets `{ [key]: valeur }` ; une date peut être passée en objet `Date` |

---

## Helpers du générateur

Fichier : `dyngroup_api/src/export/excel/workbook-builder.ts`.

| Fonction | Rôle |
|---|---|
| `buildKpiWorkbook(export, filtres)` | Construit le classeur complet. Lève une erreur si deux feuilles ont le même nom ou si une feuille s'appelle « Informations » (nom réservé). |
| `sendWorkbook(res, workbook, nomFichier)` | Envoie le fichier ; renvoie un 413 explicite s'il dépasse la limite Vercel. |
| `columnRange(feuille, cle)` | Référence absolue vers les données d'une colonne, pour écrire une formule. Ex. `columnRange(timesheets, 'heures')` → `'Timesheets productives'!$C$2:$C$310`. Lève une erreur si la clé n'existe pas dans la feuille. |
| `sanitizeSheetName(nom)` | Nom d'onglet valide pour Excel (utilisé automatiquement). |
| `columnLetter(index)` | Lettre de colonne à partir d'un index (1 → A, 27 → AA). |

### Écrire une formule vérifiable

L'intérêt de mettre une formule plutôt qu'une valeur figée : l'utilisateur voit le calcul se refaire depuis les données brutes, et le total bouge si une ligne est modifiée. Le classeur est configuré pour recalculer toutes les formules à l'ouverture.

```ts
{
  label: 'H. Productivité',
  value: totalProductif,  // affiché avant recalcul (aperçus, viewers qui ne recalculent pas)
  formula: `SUM(${columnRange(timesheets, 'heures')})`,
  numFmt: '0.00',
}
```

Les formules s'écrivent **en syntaxe anglaise avec des virgules** (`SUMIFS(a, b, "x")`), jamais avec les noms français ni des points-virgules : Excel les traduit automatiquement à l'affichage selon la langue de l'utilisateur.

---

## Ajouter un KPI

Chaque KPI a son propre fichier, avec ses propres requêtes. La base ne mutualise que ce qui est commun (filtres, périmètre, mise en forme, envoi).

### 1. Créer l'exporteur

Fichier : `dyngroup_api/src/export/operationnel/kpis/<kpi>.ts`. Exemple complet avec un KPI fictif « H. Productivité » :

```ts
import { pool } from "../../../db/pool";
import { columnRange } from "../../excel/workbook-builder";
import { DataSheet, KpiExport } from "../../excel/kpi-export.types";
import { EmployeeScope, OperationnelExportFilters } from "../export-filters";

export async function exportHProductivite(
    _filters: OperationnelExportFilters,
    scope: EmployeeScope
): Promise<KpiExport> {
    // Même requête que le dashboard, mais ligne par ligne au lieu d'agrégée.
    const res = await pool.query(
        `SELECT aal.date::date AS date, emp.name AS employe, aal.name AS libelle, aal.unit_amount AS heures
         FROM staging.account_analytic_line aal
         JOIN staging.hr_employee emp ON emp.id = aal.employee_id
         WHERE aal.employee_id = ANY($1::int[])
           AND aal.date::date BETWEEN $2 AND $3
           AND NOT (aal.name LIKE 'Congé (%' AND aal.amount = 0)
           AND aal.productivity = true
         ORDER BY aal.date, emp.name`,
        [scope.employeeIds, scope.dateFrom, scope.dateTo]
    );

    const timesheets: DataSheet = {
        name: "Timesheets productives",
        description: "Lignes de timesheet avec Productivité = Oui, hors lignes fériés fictives",
        columns: [
            { header: "Date", key: "date", width: 12, numFmt: "dd/mm/yyyy" },
            { header: "Collaborateur", key: "employe", width: 24 },
            { header: "Libellé", key: "libelle", width: 50 },
            { header: "Heures", key: "heures", width: 10, numFmt: "0.00" },
        ],
        rows: res.rows.map(r => ({ ...r, heures: parseFloat(r.heures) || 0 })),
    };
    const total = timesheets.rows.reduce((s, r) => s + (r.heures as number), 0);

    return {
        definition: {
            id: "h-productivite",
            titre: "H. Productivité",
            onglet: "Suivi Mensuel & Détails",
            description: "Heures marquées « productives » dans les feuilles de temps",
            metier: "Volume de travail à valeur ajoutée",
            formule: "H.Productivité = Σ Heures productives",
            sourceOdoo: "Feuilles de temps, case « Productivité »",
            tables: ["staging.account_analytic_line", "staging.hr_employee"],
            commentaires: ["Exclut les lignes fériés fictives (Congé + montant 0)"],
        },
        derivation: [{
            label: "H. Productivité",
            value: total,
            formula: `SUM(${columnRange(timesheets, "heures")})`,
            numFmt: "0.00",
            children: [
                { label: "Source", detail: "Feuilles de temps (account_analytic_line)", children: [
                    { label: "Filtre", detail: "Productivité = Oui" },
                    { label: "Filtre", detail: "Hors lignes fériés fictives (Congé + montant 0)" },
                    { label: "Filtre", detail: "Collaborateurs et période des filtres du dashboard" },
                ] },
                { label: "Opération", detail: "Σ colonne « Heures » de la feuille Timesheets productives" },
            ],
        }],
        sheets: [timesheets],
    };
}
```

### 2. L'enregistrer

Dans `dyngroup_api/src/export/operationnel/kpi-registry.ts` :

```ts
import { exportHProductivite } from "./kpis/h-productivite";

export const OPERATIONNEL_KPI_EXPORTERS: Record<string, OperationnelKpiExporter> = {
    "h-productivite": exportHProductivite,
};
```

La clé du registre, le `definition.id` et le `kpiId` du bouton doivent être identiques.

### 3. Poser le bouton

Dans le composant du dashboard, importer le bouton (`imports: [..., ExportButton]` du composant standalone) et le placer sur le KPI :

```html
<app-export-button kpiId="h-productivite" [params]="exportParams"></app-export-button>
```

### Règles à suivre pour chaque KPI

- **Mêmes requêtes que le dashboard.** Reprendre les conditions exactes de `operationnel.controller.ts` (mêmes exclusions, mêmes jointures), sinon l'Excel ne donnera pas les mêmes chiffres que l'écran. Vérifier le total de l'export contre la valeur affichée pour au moins un collaborateur.
- **Périmètre depuis `scope`.** Toujours filtrer avec `scope.employeeIds`, `scope.dateFrom` et `scope.dateTo`, jamais relire les filtres bruts dans la requête.
- **Fiche depuis la documentation.** Reprendre titre, description, métier, formule et cible de `docs/operationnel-kpi-details.md`, pour que l'Excel et la documentation disent la même chose.
- **Colonnes utiles seulement.** Ne mettre dans les feuilles de données que les colonnes qui expliquent le calcul, pour rester sous la limite de taille (voir plus bas).
- **Formule quand c'est possible.** Si la valeur se recalcule simplement depuis une feuille (somme, somme conditionnelle, moyenne), mettre la formule sur la racine avec `columnRange()`.

---

## Côté frontend

### `KpiExportService`

Fichier : `dyngroup_UI/src/app/shared/kpi-export.service.ts`.

```ts
download(dashboard: string, kpiId: string, params: KpiExportParams): Promise<void>
```

- appelle `GET /api/<dashboard>/export/<kpiId>` ; une valeur tableau devient un paramètre répété (`?companies=A&companies=B`) ;
- lit le nom du fichier dans l'en-tête `Content-Disposition` (l'API l'expose via `Access-Control-Expose-Headers`, sans quoi le navigateur le cacherait à cause de CORS) ;
- déclenche le téléchargement ;
- en cas d'erreur, lève une `Error` avec le message renvoyé par l'API.

Le paramètre `dashboard` rend le service réutilisable pour un futur export Finance (`/api/finance/export/...`).

### `ExportButton`

Fichier : `dyngroup_UI/src/app/shared/export-button/`. Sélecteur `app-export-button`.

| Entrée | Obligatoire | Défaut | Sens |
|---|---|---|---|
| `kpiId` | oui | | Identifiant du KPI |
| `params` | oui | | Filtres actifs (`exportParams`) |
| `dashboard` | non | `'operationnel'` | Dashboard concerné |

Affiche « ⬇ Excel », passe à « Export… » (désactivé) pendant la génération, et affiche une alerte avec le message de l'API en cas d'échec.

### `exportParams` (dashboard Opérationnel)

Getter du composant `operationnel-dashboard`, qui traduit les filtres actifs au format de l'API :

| Filtre du dashboard | Paramètre envoyé |
|---|---|
| `activeYear` | `annee` |
| `activeMonth` (`'all'` ou index `0`-`11`) | `mois` (`'all'` ou `1`-`12`) |
| `activeCollab` (`'all'` ou nom) | `collab` |
| `activeCompanies` | `companies` (répété) |

### Ouverture du fichier

Un navigateur ne peut pas ouvrir Excel directement. Après le clic, le fichier est téléchargé, puis s'ouvre en un clic depuis la barre de téléchargements (ou automatiquement si le navigateur est réglé pour ouvrir ce type de fichier).

---

## Contraintes et points d'attention

| Contrainte | Détail | Ce que fait la base |
|---|---|---|
| **Taille de réponse Vercel** | L'API de prod est une fonction serverless Vercel, limitée à 4.5 MB par réponse. Un export « tous collaborateurs, année complète » avec toutes les lignes de timesheet peut s'en approcher. | Au-delà de 4.3 MB, renvoie un 413 avec un message clair au lieu de l'erreur générique de Vercel. |
| **Durée d'exécution Vercel** | Une fonction serverless a un temps d'exécution limité ; les requêtes d'un exporteur doivent rester raisonnables. | À surveiller par KPI (pas de garde automatique). |
| **Syntaxe des formules** | Anglais + virgules, sinon la formule est invalide. | Documenté sur le champ `formula`. |
| **Noms d'onglets** | 31 caractères max, sans `[]:*?/\`, uniques, « Informations » réservé. | Nettoyage automatique ; erreur explicite en cas de doublon. |
| **Profondeur de l'arbre** | Excel limite le regroupement de lignes à 7 niveaux. | Au-delà, les niveaux sont plafonnés à 7 (l'indentation continue, le regroupement non). |
| **Recalcul des formules** | Certains aperçus (ex. prévisualisation d'e-mail) n'exécutent pas les formules. | Si l'exporteur renseigne aussi `value` à côté de `formula`, cette valeur est affichée avant recalcul — à toujours faire. |

---

## Tester

### Générateur seul (sans base de données)

Construire un `KpiExport` fictif, appeler `buildKpiWorkbook()`, écrire le fichier avec `workbook.xlsx.writeFile(...)`, puis le relire avec ExcelJS (ou l'ouvrir dans Excel) pour vérifier les feuilles, l'arbre et les formules. C'est ainsi que la base a été validée.

### Route

API démo lancée en local :

```bash
curl -s -w "\nHTTP %{http_code}\n" \
  "http://localhost:3000/api/operationnel/export/<kpiId>?annee=2026&mois=all&collab=all"
```

- tant que le KPI n'est pas enregistré : `404 {"error":"Export inconnu : <kpiId>"}` ;
- une fois enregistré : ajouter `-o test.xlsx` pour récupérer le fichier.

### Cohérence avec le dashboard

Pour chaque nouveau KPI : comparer la valeur racine de l'export à la valeur affichée dans le dashboard, avec les mêmes filtres, sur au moins un collaborateur (ex. AGACHII Igor) et en vue « tous les collaborateurs ».
