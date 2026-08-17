import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { tablesConfig } from "./config/tables.config";
import { createGenericRouter } from "./routes/genericRoutes";
import operationnelRouter from "./routes/operationnel.routes";
import okrRouter from "./routes/okr.routes";
import dashboardRouter from "./routes/dashboard.routes";
import authRouter from "./routes/auth.routes";
import organigramRouter from "./routes/organigram.routes";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Custom routes
app.use("/api/auth", authRouter);
app.use("/api/operationnel", operationnelRouter);
app.use("/api/okr", okrRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/organigram", organigramRouter);

tablesConfig.forEach(({ name, primaryKey, schema }) => {
    const pk = primaryKey === undefined ? "id" : primaryKey;
    app.use(`/api/${name}`, createGenericRouter(name, pk, schema ?? "public"));
});

export default app;