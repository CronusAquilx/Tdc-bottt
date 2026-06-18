import { Router, type IRouter } from "express";
import healthRouter from "./health";
import discordRouter from "./discord";
import rafflesRouter from "./raffles";

const router: IRouter = Router();

router.use(healthRouter);
router.use(discordRouter);
router.use(rafflesRouter);

export default router;
