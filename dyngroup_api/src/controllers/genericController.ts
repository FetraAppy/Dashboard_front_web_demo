import { Request, Response } from "express";
import { GenericRepository } from "../repositories/genericRepository";

export function createGenericController(repo: GenericRepository) {
    return {
        // getAll: async (req: Request, res: Response) => {
        //     try {
        //         const { limit, offset, ...filters } = req.query;
        //         const limitNum = parseInt(limit as string) || 100;
        //         const offsetNum = parseInt(offset as string) || 0;
        //         const data = await repo.findAll(limitNum, offsetNum, filters as Record<string, any>);
        //         res.json(data);
        //     } catch (err) {
        //         console.error(err);
        //         res.status(500).json({ error: "Erreur serveur" });
        //     }
        // },

        getAll: async (req: Request, res: Response) => {
            try {
                const { limit, offset, ...filters } = req.query;
                const limitNum = limit ? parseInt(limit as string) : 0;
                const offsetNum = parseInt(offset as string) || 0;
                const data = await repo.findAll(limitNum, offsetNum, filters as Record<string, any>);
                res.json(data);
            } catch (err) {
                console.error(err);
                res.status(500).json({ error: "Erreur serveur" });
            }
        },

        // getById: async (req: Request, res: Response) => {
        //     try {
        //         const item = await repo.findById(req.params.id);
        //         if (!item) return res.status(404).json({ error: "Non trouvé" });
        //         res.json(item);
        //     } catch (err) {
        //         console.error(err);
        //         res.status(500).json({ error: "Erreur serveur" });
        //     }
        // },

        // create: async (req: Request, res: Response) => {
        //     try {
        //         const item = await repo.create(req.body);
        //         res.status(201).json(item);
        //     } catch (err) {
        //         console.error(err);
        //         res.status(500).json({ error: "Erreur serveur" });
        //     }
        // },

        // update: async (req: Request, res: Response) => {
        //     try {
        //         const item = await repo.update(req.params.id, req.body);
        //         if (!item) return res.status(404).json({ error: "Non trouvé" });
        //         res.json(item);
        //     } catch (err) {
        //         console.error(err);
        //         res.status(500).json({ error: "Erreur serveur" });
        //     }
        // },

        // remove: async (req: Request, res: Response) => {
        //     try {
        //         const deleted = await repo.delete(req.params.id);
        //         if (!deleted) return res.status(404).json({ error: "Non trouvé" });
        //         res.status(204).send();
        //     } catch (err) {
        //         console.error(err);
        //         res.status(500).json({ error: "Erreur serveur" });
        //     }
        // },
    };
}