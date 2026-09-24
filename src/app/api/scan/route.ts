import { NextRequest } from "next/server";
import { guard, json } from "@/lib/api";
import { ScanAlreadyRunningError, runScan } from "@/lib/scan";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = guard(req, true);
  if (denied) return denied;
  try {
    return json(await runScan());
  } catch (error) {
    if (error instanceof ScanAlreadyRunningError) return json({ error: error.message }, 409);
    return json({ error: "Controle mislukt. Probeer opnieuw." }, 500);
  }
}
