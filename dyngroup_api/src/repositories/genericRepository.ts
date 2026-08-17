import { pool } from "../db/pool";

function isValidIdentifier(name: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

export class GenericRepository<T = any> {
    private tableName: string;
    private schema: string;
    private primaryKey: string | null;
    private qualifiedTable: string;

    constructor(tableName: string, primaryKey: string | null = "id", schema: string = "public") {
        if (!isValidIdentifier(tableName)) throw new Error(`Nom de table invalide: ${tableName}`);
        if (!isValidIdentifier(schema)) throw new Error(`Nom de schéma invalide: ${schema}`);
        if (primaryKey !== null && !isValidIdentifier(primaryKey)) {
            throw new Error(`Nom de clé primaire invalide: ${primaryKey}`);
        }

        this.tableName = tableName;
        this.schema = schema;
        this.primaryKey = primaryKey;
        this.qualifiedTable = `"${schema}"."${tableName}"`;
    }

    // async findAll(limit = 100, offset = 0, filters: Record<string, any> = {}): Promise<T[]> {
    //     const filterKeys = Object.keys(filters).filter((k) => filters[k] !== undefined);
    //     filterKeys.forEach((col) => {
    //         if (!isValidIdentifier(col)) throw new Error(`Colonne de filtre invalide: ${col}`);
    //     });

    //     const values: any[] = [];
    //     let whereClause = "";
    //     if (filterKeys.length > 0) {
    //         const conditions = filterKeys.map((col) => {
    //             values.push(filters[col]);
    //             return `"${col}" = $${values.length}`;
    //         });
    //         whereClause = `WHERE ${conditions.join(" AND ")}`;
    //     }

    //     const orderClause = this.primaryKey ? `ORDER BY "${this.primaryKey}"` : "";

    //     values.push(limit);
    //     const limitIdx = values.length;
    //     values.push(offset);
    //     const offsetIdx = values.length;

    //     const sql = `SELECT * FROM ${this.qualifiedTable} ${whereClause} ${orderClause} LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
    //     const result = await pool.query(sql, values);
    //     return result.rows;
    // }

    async findAll(limit = 0, offset = 0, filters: Record<string, any> = {}): Promise<T[]> {
        const filterKeys = Object.keys(filters).filter((k) => filters[k] !== undefined);
        filterKeys.forEach((col) => {
            if (!isValidIdentifier(col)) throw new Error(`Colonne de filtre invalide: ${col}`);
        });

        const values: any[] = [];
        let whereClause = "";
        if (filterKeys.length > 0) {
            const conditions = filterKeys.map((col) => {
                values.push(filters[col]);
                return `"${col}" = $${values.length}`;
            });
            whereClause = `WHERE ${conditions.join(" AND ")}`;
        }

        const orderClause = this.primaryKey ? `ORDER BY "${this.primaryKey}"` : "";

        // Si limit = 0, pas de clause LIMIT/OFFSET
        let paginationClause = "";
        if (limit > 0) {
            values.push(limit);
            const limitIdx = values.length;
            values.push(offset);
            const offsetIdx = values.length;
            paginationClause = `LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
        }

        const sql = `SELECT * FROM ${this.qualifiedTable} ${whereClause} ${orderClause} ${paginationClause}`;
        const result = await pool.query(sql, values);
        return result.rows;
    }

    async findById(id: number | string): Promise<T | null> {
        if (!this.primaryKey) throw new Error("Cette table n'a pas de clé primaire définie");
        const result = await pool.query(
            `SELECT * FROM ${this.qualifiedTable} WHERE "${this.primaryKey}" = $1`,
            [id]
        );
        return result.rows[0] ?? null;
    }

    async create(data: Record<string, any>): Promise<T> {
        const columns = Object.keys(data);
        columns.forEach((col) => {
            if (!isValidIdentifier(col)) throw new Error(`Colonne invalide: ${col}`);
        });
        const values = Object.values(data);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        const colNames = columns.map((c) => `"${c}"`).join(", ");
        const result = await pool.query(
            `INSERT INTO ${this.qualifiedTable} (${colNames}) VALUES (${placeholders}) RETURNING *`,
            values
        );
        return result.rows[0];
    }

    async update(id: number | string, data: Record<string, any>): Promise<T | null> {
        if (!this.primaryKey) throw new Error("Cette table n'a pas de clé primaire définie");
        const columns = Object.keys(data);
        columns.forEach((col) => {
            if (!isValidIdentifier(col)) throw new Error(`Colonne invalide: ${col}`);
        });
        const values = Object.values(data);
        const setClause = columns.map((col, i) => `"${col}" = $${i + 1}`).join(", ");
        const result = await pool.query(
            `UPDATE ${this.qualifiedTable} SET ${setClause} WHERE "${this.primaryKey}" = $${columns.length + 1} RETURNING *`,
            [...values, id]
        );
        return result.rows[0] ?? null;
    }

    async delete(id: number | string): Promise<boolean> {
        if (!this.primaryKey) throw new Error("Cette table n'a pas de clé primaire définie");
        const result = await pool.query(
            `DELETE FROM ${this.qualifiedTable} WHERE "${this.primaryKey}" = $1`,
            [id]
        );
        return (result.rowCount ?? 0) > 0;
    }
}