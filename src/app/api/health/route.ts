import { connection } from "next/server";
import { getPublicRuntimeConfig } from "@/config/server-env";
import { errorResponse } from "@/server/api-response";

/** Liveness + effective (non-secret) configuration. Does not call the venue. */
export async function GET(): Promise<Response> {
  await connection();
  try {
    return Response.json(
      { status: "ok", config: getPublicRuntimeConfig() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
