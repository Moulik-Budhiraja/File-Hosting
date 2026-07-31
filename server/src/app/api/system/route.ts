import { errorResponse, json } from "@/server/files/http";
import { requireApiService } from "@/server/files/request";

import packageJson from "../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const service = await requireApiService(request);
    const info = await service.systemInfo();
    return json({
      version: packageJson.version,
      node: info.node,
      uptime_seconds: info.uptimeSeconds,
      storage: {
        free_bytes: info.storage.freeBytes,
        object_bytes: info.storage.objectBytes,
        object_count: info.storage.objectCount,
        public_count: info.storage.publicCount,
        private_count: info.storage.privateCount,
        temp_part_count: info.storage.tempPartCount,
      },
      database: { db_bytes: info.database.dbBytes },
      config: {
        max_upload_bytes: info.config.maxUploadBytes,
        min_free_bytes: info.config.minFreeBytes,
        public_url: info.config.publicUrl,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
