import { and, eq } from "drizzle-orm";
import type { Finding } from "../analytics/detectors.js";
import type { Db } from "../db/client.js";
import { channelAccounts, extObjects } from "../db/schema.js";
import { propose, type ProposeResult } from "./proposals.js";

// Detector suggestions become proposals. The detector knows our object id;
// the proposal needs the account, the platform id and the state assumed,
// all read from the mirror so the executor can refuse a stale one.

export async function proposeFromFindings(db: Db, brandId: string, findings: Finding[], evidenceOf: (f: Finding) => Record<string, unknown>): Promise<ProposeResult[]> {
  const out: ProposeResult[] = [];
  for (const f of findings) {
    if (!f.suggested) continue;
    const extObjectId = f.suggested.payload["extObjectId"];
    if (typeof extObjectId !== "string") continue;
    const [obj] = await db
      .select({ id: extObjects.id, kind: extObjects.kind, externalId: extObjects.externalId, status: extObjects.status, dailyBudgetMicros: extObjects.dailyBudgetMicros, channelAccountId: extObjects.channelAccountId })
      .from(extObjects)
      .innerJoin(channelAccounts, eq(channelAccounts.id, extObjects.channelAccountId))
      .where(and(eq(extObjects.id, extObjectId), eq(channelAccounts.brandId, brandId)));
    if (!obj || (obj.kind !== "ad" && obj.kind !== "ad_group" && obj.kind !== "campaign")) continue;
    if (f.suggested.type === "PAUSE_AD") {
      if (obj.status !== "ACTIVE") continue; // already paused: nothing to propose
      out.push(
        await propose(db, {
          brandId,
          payload: { type: "PAUSE_AD", kind: obj.kind, externalId: obj.externalId, channelAccountId: obj.channelAccountId, extObjectId: obj.id, assumptions: { status: obj.status } },
          reason: f.suggested.reason,
          source: `detector:${f.detector}`,
          evidence: evidenceOf(f),
          expectedOutcome: "Stops spend on an ad that is not producing registrations.",
        }),
      );
    }
  }
  return out;
}
