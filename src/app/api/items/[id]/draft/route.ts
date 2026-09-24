import { NextRequest } from "next/server";
import { guard, json } from "@/lib/api";
import { getItem } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guard(req, true);
  if (denied) return denied;
  const { id } = await context.params;
  const item = getItem(id);
  if (!item) return json({ error: "Item niet gevonden." }, 404);
  if (!item.sourceRefs.some((ref) => ref.kind === "gmail")) return json({ error: "Er is geen Gmail-bron voor dit item." }, 400);
  const topic = item.title.replace(/^(?:Reageer op|Controleer|Wacht op antwoord):\s*/i, "").slice(0, 100);
  const subject = `Re: ${topic}`;
  const body = item.status === "wachten_op_ander"
    ? `Hallo,\n\nIk wilde graag navragen of er een update is over ${topic}.\n\nMet vriendelijke groet,\nKenny`
    : item.status === "controleren"
      ? `Hallo,\n\nKun je bevestigen wat de huidige status is van ${topic}? Dan weet ik of er nog iets van mijn kant nodig is.\n\nMet vriendelijke groet,\nKenny`
      : `Hallo,\n\nBedankt voor je bericht over ${topic}. Ik heb je verzoek gezien en kom hierop terug.\n\nMet vriendelijke groet,\nKenny`;
  return json({ subject, body, disclaimer: "Concept: controleer inhoud, ontvanger en toon. Er is niets verzonden." });
}
