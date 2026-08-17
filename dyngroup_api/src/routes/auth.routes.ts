import { Router, Request, Response } from "express";

const authRouter = Router();

authRouter.post("/login", (req: Request, res: Response) => {
    const { email, password } = req.body;
    const expectedEmail = process.env.DASHBOARD_EMAIL || "admin@dyngroup.ch";
    const expectedPassword = process.env.DASHBOARD_PASSWORD || "dyngroup2026";
    if (email === expectedEmail && password === expectedPassword) {
        return res.json({ success: true, token: "authenticated_dyn_token_2026" });
    } else {
        return res.status(401).json({ error: "Email ou mot de passe incorrect" });
    }
});

authRouter.post("/verify", (req: Request, res: Response) => {
    const { token } = req.body;
    if (token === "authenticated_dyn_token_2026") {
        return res.json({ valid: true });
    } else {
        return res.status(401).json({ valid: false });
    }
});

export default authRouter;
