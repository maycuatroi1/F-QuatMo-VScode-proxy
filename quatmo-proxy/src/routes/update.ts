import { Hono } from "hono";
import { resolveNativeUpdate, getPublicRelease, getAdminRelease } from "../modules/releases/publicHandlers";
import { downloadReleaseArtifact } from "../modules/releases/artifactHandler";
import { syncReleaseFromS3, publishRelease } from "../modules/releases/adminHandlers";

export const updateRouter = new Hono();

updateRouter.get("/api/update/:platform/:quality/:commit", resolveNativeUpdate);
updateRouter.get("/releases/:filename", downloadReleaseArtifact);
updateRouter.get("/release/current", getPublicRelease);
updateRouter.get("/admin/release/current", getAdminRelease);
updateRouter.post("/release/sync-s3", syncReleaseFromS3);
updateRouter.post("/release/set-latest", publishRelease);

export { getCurrentRelease, saveReleaseManifest, getLatestRelease } from "../modules/releases/store";
export type { UpdateType, ReleaseManifest } from "../modules/releases/types";
