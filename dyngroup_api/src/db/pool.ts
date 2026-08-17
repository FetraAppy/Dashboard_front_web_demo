import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,                          // augmente la capacité (ajuste selon la limite Postgres)
    idleTimeoutMillis: 30000,         // ferme les connexions inactives après 30s
    connectionTimeoutMillis: 5000,    // échoue après 5s au lieu de bloquer indéfiniment
});

// Log les erreurs de connexions inactives (souvent révélateur de fuites)
pool.on('error', (err) => {
    console.error('Erreur inattendue sur un client idle du pool', err);
});

// Utile en debug : voir l'état du pool à intervalle régulier
setInterval(() => {
    console.log(`[pool] total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
}, 5000);