import { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json } from "@/lib/api";
import { patchItem } from "@/lib/db";

export const runtime = "nodejs";

const date = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/).refine((value) => Number.isFinite(Date.parse(value))),
  z.null(),
]);

const schema = z.object({
  status: z.enum(["actie_nodig", "wachten_op_ander", "gepland", "controleren", "afgerond", "genegeerd"]).optional(),
  snoozedUntil: date.optional(),
  correction: z.object({
    title: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().min(1).max(1000).optional(),
    nextStep: z.string().trim().min(1).max(500).optional(),
    owner: z.string().trim().min(1).max(160).optional(),
    category: z.enum(["prive", "woning", "auto", "aankopen", "werk", "bedrijf", "kvw"]).optional(),
    dueAt: date.optional(),
  }).strict().optional(),
}).strict();

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guard(req, true);
  if (denied) return denied;
  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "Ongeldige JSON." }, 400); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return json({ error: "Ongeldige wijziging.", fields: z.treeifyError(parsed.error) }, 400);
  const { id } = await context.params;
  const item = patchItem(id, parsed.data);
  return item ? json(item) : json({ error: "Item niet gevonden." }, 404);
}
