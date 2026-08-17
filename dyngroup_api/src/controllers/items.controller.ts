import { Request, Response } from "express";
import { pool } from "../db/pool";

export const getItems = async (req: Request, res: Response) => {
  try {
    const result = await pool.query("SELECT * FROM items ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
};