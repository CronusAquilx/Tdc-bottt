import { getSetting, setSetting, saveDatabaseSnapshot } from "../db.js";

export const UPDATE_ROLLOUT_KEY = "tdc_update_v1_enabled";

export async function isUpdateEnabled(): Promise<boolean> {
  return (await getSetting(UPDATE_ROLLOUT_KEY)) === "true";
}

export async function enableUpdate(): Promise<void> {
  await setSetting(UPDATE_ROLLOUT_KEY, "true");
  await saveDatabaseSnapshot().catch(error => {
    console.error("[TDC] Update is enabled, but its extra database snapshot failed:", error);
  });
}
