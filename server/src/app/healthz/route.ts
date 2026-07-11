import { errorResponse, json } from "@/server/files/http";
import { getFileService } from "@/server/files/singleton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const service = await getFileService();
    const health = await service.checkHealth();
    return json({ status: "ok", free_bytes: health.freeBytes });
  } catch (error) {
    const response = errorResponse(error);
    return new Response(response.body, {
      status: 503,
      headers: response.headers,
    });
  }
}
