import { errorResponse, json } from "@/server/files/http";
import { AppError } from "@/server/files/errors";
import { requireApiContext } from "@/server/files/request";

import packageJson from "../../../../package.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { service, principal } = await requireApiContext(request);
    if (principal.role !== "admin") {
      throw new AppError(403, "forbidden", "Administrator access required");
    }
    const info = await service.systemInfo();
    return json({
      version: packageJson.version,
      node: info.node,
      uptime_seconds: info.uptimeSeconds,
      storage: {
        volume_total_bytes: info.storage.volumeTotalBytes,
        volume_used_bytes: info.storage.volumeUsedBytes,
        free_bytes: info.storage.freeBytes,
        object_bytes: info.storage.objectBytes,
        object_count: info.storage.objectCount,
        public_count: info.storage.publicCount,
        protected_count: info.storage.protectedCount,
        private_count: info.storage.privateCount,
        temp_part_count: info.storage.tempPartCount,
      },
      database: { db_bytes: info.database.dbBytes },
      // Current in-flight transfers for THIS server process only; no history.
      transfers: service.activeTransfers().map((transfer) => ({
        direction: transfer.direction,
        name: transfer.name,
        bytes: transfer.bytes,
        total_bytes: transfer.totalBytes,
        started_at: transfer.startedAt,
      })),
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
