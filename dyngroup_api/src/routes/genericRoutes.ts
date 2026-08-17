import { Router } from "express";
import { GenericRepository } from "../repositories/genericRepository";
import { createGenericController } from "../controllers/genericController";

export function createGenericRouter(
    tableName: string,
    primaryKey: string | null = "id",
    schema: string = "public"
): Router {
    const router = Router();
    const repo = new GenericRepository(tableName, primaryKey, schema);
    const controller = createGenericController(repo);

    router.get("/", controller.getAll);
    //   router.post("/", controller.create);

    //   if (primaryKey) {
    //     router.get("/:id", controller.getById);
    //     router.put("/:id", controller.update);
    //     router.delete("/:id", controller.remove);
    //   }

    return router;
}