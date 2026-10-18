import { Router, type IRouter } from "express";
import healthRouter from "./health";
import discordRouter from "./discord";
import rafflesRouter from "./raffles";
import portalRouter from "./portal";

const router: IRouter = Router();

router.use(healthRouter);
router.use(discordRouter);
router.use(rafflesRouter);
router.use(portalRouter);

export default router;
