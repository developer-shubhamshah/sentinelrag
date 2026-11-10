import { fetchJson, type RawDoc } from "./types.js";

/**
 * MITRE ATT&CK Enterprise STIX bundle (verified live):
 *   https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json
 *
 * Techniques are STIX `attack-pattern` objects. The ATT&CK ID (e.g. T1059,
 * T1059.001) lives in external_references where source_name === 'mitre-attack'.
 */

const BUNDLE_URL =
  "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json";

interface StixObject {
  type: string;
  name?: string;
  description?: string;
  revoked?: boolean;
  x_mitre_deprecated?: boolean;
  x_mitre_platforms?: string[];
  x_mitre_is_subtechnique?: boolean;
  kill_chain_phases?: Array<{ kill_chain_name?: string; phase_name?: string }>;
  external_references?: Array<{ source_name?: string; external_id?: string; url?: string }>;
}

interface StixBundle {
  objects?: StixObject[];
}

function attackId(obj: StixObject): string | null {
  const ref = obj.external_references?.find((r) => r.source_name === "mitre-attack" && r.external_id);
  return ref?.external_id ?? null;
}

function tactics(obj: StixObject): string[] {
  return (obj.kill_chain_phases ?? [])
    .filter((p) => p.kill_chain_name === "mitre-attack" && p.phase_name)
    .map((p) => (p.phase_name as string).replace(/-/g, " "));
}

export async function loadAttack(opts: { maxTechniques?: number } = {}): Promise<RawDoc[]> {
  const { maxTechniques = Infinity } = opts;
  process.stdout.write("  [attack] downloading enterprise STIX bundle ...\n");
  const bundle = (await fetchJson(BUNDLE_URL)) as StixBundle;
  const objects = bundle.objects ?? [];

  const docs: RawDoc[] = [];
  for (const obj of objects) {
    if (obj.type !== "attack-pattern") continue;
    if (obj.revoked || obj.x_mitre_deprecated) continue;
    const id = attackId(obj);
    if (!id || !obj.name) continue;

    const tac = tactics(obj);
    const platforms = obj.x_mitre_platforms ?? [];
    const lines = [
      `${id} — ${obj.name}`,
      obj.description ?? "",
      tac.length ? `Tactics: ${tac.join(", ")}.` : "",
      platforms.length ? `Platforms: ${platforms.join(", ")}.` : "",
    ].filter(Boolean);

    docs.push({
      source: "attack",
      extId: id,
      title: obj.name,
      text: lines.join("\n"),
      metadata: {
        tactics: tac,
        platforms,
        isSubtechnique: obj.x_mitre_is_subtechnique ?? false,
      },
    });
    if (docs.length >= maxTechniques) break;
  }
  process.stdout.write(`  [attack] kept ${docs.length} techniques\n`);
  return docs;
}
