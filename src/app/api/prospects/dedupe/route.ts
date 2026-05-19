import { createSupabaseServerClient, MissingServerEnvError } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ProspectRecord = Record<string, unknown> & {
  id: string | number;
  created_at?: string | null;
};

type DuplicateMatch = {
  reason:
    | "same_google_place_id"
    | "same_school_city_state"
    | "same_domain_similar_name"
    | "same_phone_similar_name";
  confidence: number;
};

type DuplicateGroup = {
  canonical: ProspectRecord;
  duplicates: ProspectRecord[];
  matchByDuplicateId: Map<string, DuplicateMatch>;
};

const SCALAR_MERGE_FIELDS = [
  "website",
  "main_phone",
  "full_address",
  "school_type",
  "grades_served",
  "hs_enrollment",
  "total_enrollment",
  "student_life_url",
  "clubs_activities_url",
  "clubs_count_estimate",
  "club_activity_signal",
  "fit_score",
  "personalization_angle",
  "research_notes",
  "target_persona",
  "contact_name",
  "contact_title",
  "contact_email",
  "contact_phone",
  "contact_source_url",
  "contact_confidence",
  "contact_email_validation_status",
  "email_validation_status",
  "email_validation_checked_at",
  "email_validation_provider",
  "email_validation_checked_email",
  "bec_status",
  "bec_event",
  "bec_details",
];

const ARRAY_MERGE_FIELDS = ["source_urls", "fields_not_found"];
const RAW_FILL_ONLY_FIELDS = ["raw_google_json", "raw_openai_json", "bec_raw_json"];

export async function POST() {
  try {
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase.from("prospects").select("*");

    if (error) {
      return jsonError("Supabase select failure.", 500);
    }

    const prospects = ((data ?? []) as ProspectRecord[]).filter((row) => row.id);

    if (prospects.length === 0) {
      return Response.json({
        total_checked: 0,
        duplicate_groups_found: 0,
        duplicates_moved: 0,
        canonical_records_updated: 0,
        active_prospects_remaining: 0,
        message: "No duplicates found.",
      });
    }

    const groups = findDuplicateGroups(prospects);

    if (groups.length === 0) {
      return Response.json({
        total_checked: prospects.length,
        duplicate_groups_found: 0,
        duplicates_moved: 0,
        canonical_records_updated: 0,
        active_prospects_remaining: prospects.length,
        message: "No duplicates found.",
      });
    }

    let canonicalRecordsUpdated = 0;

    for (const group of groups) {
      const merged = buildCanonicalMerge(group.canonical, group.duplicates);

      if (Object.keys(merged).length === 0) {
        continue;
      }

      const { error: updateError } = await supabase
        .from("prospects")
        .update(merged)
        .eq("id", group.canonical.id);

      if (updateError) {
        return jsonError("Canonical update failure.", 500);
      }

      canonicalRecordsUpdated += 1;
    }

    const now = new Date().toISOString();
    const archiveRows = groups.flatMap((group) =>
      group.duplicates.map((duplicate) => {
        const duplicateId = idKey(duplicate.id);
        const match = group.matchByDuplicateId.get(duplicateId) ?? {
          reason: "same_school_city_state" as const,
          confidence: 95,
        };

        return {
          ...duplicate,
          original_prospect_id: duplicate.id,
          canonical_prospect_id: group.canonical.id,
          duplicate_reason: match.reason,
          duplicate_confidence: match.confidence,
          duplicate_group_key: idKey(group.canonical.id),
          moved_to_duplicates_at: now,
        };
      }),
    );

    const duplicateIds = archiveRows.map((row) => row.original_prospect_id);

    const { error: archiveError } = await supabase
      .from("prospects_duplicates")
      .upsert(archiveRows, { onConflict: "original_prospect_id" });

    if (archiveError) {
      return jsonError("Duplicate archive insert failure.", 500);
    }

    const { error: deleteError } = await supabase
      .from("prospects")
      .delete()
      .in("id", duplicateIds);

    if (deleteError) {
      return jsonError("Duplicate delete failure.", 500);
    }

    const activeProspectsRemaining = prospects.length - duplicateIds.length;

    return Response.json({
      total_checked: prospects.length,
      duplicate_groups_found: groups.length,
      duplicates_moved: duplicateIds.length,
      canonical_records_updated: canonicalRecordsUpdated,
      active_prospects_remaining: activeProspectsRemaining,
      message: `Moved ${duplicateIds.length} duplicates into prospects_duplicates. ${activeProspectsRemaining} active prospects remain.`,
    });
  } catch (error) {
    if (error instanceof MissingServerEnvError) {
      return jsonError(`Missing ${error.envName}`, 500);
    }

    return jsonError("Unexpected server error.", 500);
  }
}

function findDuplicateGroups(prospects: ProspectRecord[]) {
  const unionFind = new UnionFind(prospects.map((prospect) => idKey(prospect.id)));
  const pairMatches = new Map<string, DuplicateMatch>();

  for (let leftIndex = 0; leftIndex < prospects.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < prospects.length;
      rightIndex += 1
    ) {
      const left = prospects[leftIndex];
      const right = prospects[rightIndex];
      const match = getDuplicateMatch(left, right);

      if (!match) {
        continue;
      }

      unionFind.union(idKey(left.id), idKey(right.id));
      pairMatches.set(pairKey(left.id, right.id), match);
    }
  }

  const rowsByRoot = new Map<string, ProspectRecord[]>();

  for (const prospect of prospects) {
    const root = unionFind.find(idKey(prospect.id));
    rowsByRoot.set(root, [...(rowsByRoot.get(root) ?? []), prospect]);
  }

  return Array.from(rowsByRoot.values())
    .filter((rows) => rows.length > 1)
    .map((rows): DuplicateGroup => {
      const canonical = chooseCanonical(rows);
      const duplicates = rows.filter((row) => idKey(row.id) !== idKey(canonical.id));
      const matchByDuplicateId = new Map<string, DuplicateMatch>();

      for (const duplicate of duplicates) {
        matchByDuplicateId.set(
          idKey(duplicate.id),
          getStrongestMatchForDuplicate(duplicate, rows, pairMatches),
        );
      }

      return { canonical, duplicates, matchByDuplicateId };
    });
}

function getDuplicateMatch(
  left: ProspectRecord,
  right: ProspectRecord,
): DuplicateMatch | null {
  const leftGooglePlaceId = stringValue(left.google_place_id);
  const rightGooglePlaceId = stringValue(right.google_place_id);

  if (leftGooglePlaceId && leftGooglePlaceId === rightGooglePlaceId) {
    return { reason: "same_google_place_id", confidence: 100 };
  }

  const leftName = normalizeName(left.school_name);
  const rightName = normalizeName(right.school_name);
  const leftCity = normalizeText(left.city);
  const rightCity = normalizeText(right.city);
  const leftState = normalizeText(left.state);
  const rightState = normalizeText(right.state);

  if (
    leftName &&
    leftName === rightName &&
    leftCity &&
    leftCity === rightCity &&
    leftState &&
    leftState === rightState
  ) {
    return { reason: "same_school_city_state", confidence: 95 };
  }

  const leftDomain = getDomain(left.website);
  const rightDomain = getDomain(right.website);
  const strongName = isStrongNameMatch(leftName, rightName);
  const passesCampusSafety = hasSameCampusSafety(left, right, leftName === rightName);

  if (
    leftDomain &&
    leftDomain === rightDomain &&
    leftState &&
    leftState === rightState &&
    strongName &&
    passesCampusSafety
  ) {
    return { reason: "same_domain_similar_name", confidence: 85 };
  }

  const leftPhone = normalizePhone(left.main_phone);
  const rightPhone = normalizePhone(right.main_phone);

  if (
    leftPhone &&
    leftPhone === rightPhone &&
    leftState &&
    leftState === rightState &&
    strongName &&
    passesCampusSafety
  ) {
    return { reason: "same_phone_similar_name", confidence: 80 };
  }

  return null;
}

function chooseCanonical(rows: ProspectRecord[]) {
  return [...rows].sort((left, right) => {
    const scoreDifference = getCanonicalScore(right) - getCanonicalScore(left);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return getTimestamp(left.created_at) - getTimestamp(right.created_at);
  })[0];
}

function getCanonicalScore(row: ProspectRecord) {
  let score = 0;

  if (stringValue(row.enrichment_status) === "enriched") score += 50;
  if (!isBlank(row.contact_email)) score += 25;
  if (!isBlank(row.contact_name)) score += 20;
  if (!isBlank(row.contact_title)) score += 15;
  if (!isBlank(row.hs_enrollment)) score += 15;
  if (!isBlank(row.website)) score += 10;
  if (!isBlank(row.main_phone)) score += 10;
  if (!isBlank(row.clubs_activities_url)) score += 10;
  if (!isBlank(row.student_life_url)) score += 10;
  if (!isBlank(row.personalization_angle)) score += 10;
  if (normalizeArray(row.source_urls).length > 0) score += 5;

  return score;
}

function buildCanonicalMerge(
  canonical: ProspectRecord,
  duplicates: ProspectRecord[],
) {
  const merged: Record<string, unknown> = {};

  for (const field of SCALAR_MERGE_FIELDS) {
    if (!isBlank(canonical[field])) {
      continue;
    }

    const value = duplicates.map((duplicate) => duplicate[field]).find((item) => !isBlank(item));

    if (!isBlank(value)) {
      merged[field] = value;
    }
  }

  for (const field of ARRAY_MERGE_FIELDS) {
    const combined = uniqueStrings([
      ...normalizeArray(canonical[field]),
      ...duplicates.flatMap((duplicate) => normalizeArray(duplicate[field])),
    ]);

    if (combined.length > normalizeArray(canonical[field]).length) {
      merged[field] = combined;
    }
  }

  for (const field of RAW_FILL_ONLY_FIELDS) {
    if (!isBlank(canonical[field])) {
      continue;
    }

    const value = duplicates.map((duplicate) => duplicate[field]).find((item) => !isBlank(item));

    if (!isBlank(value)) {
      merged[field] = value;
    }
  }

  return merged;
}

function getStrongestMatchForDuplicate(
  duplicate: ProspectRecord,
  groupRows: ProspectRecord[],
  pairMatches: Map<string, DuplicateMatch>,
) {
  const matches = groupRows
    .filter((row) => idKey(row.id) !== idKey(duplicate.id))
    .map((row) => pairMatches.get(pairKey(duplicate.id, row.id)))
    .filter((match): match is DuplicateMatch => Boolean(match));

  return matches.sort((left, right) => right.confidence - left.confidence)[0] ?? {
    reason: "same_school_city_state" as const,
    confidence: 95,
  };
}

function normalizeText(value: unknown) {
  return stringValue(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value: unknown) {
  const fillerWords = new Set(["the", "inc", "llc"]);

  return normalizeText(value)
    .split(" ")
    .filter((token) => token && !fillerWords.has(token))
    .join(" ");
}

function normalizePhone(value: unknown) {
  const digits = stringValue(value).replace(/\D+/g, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }

  return digits.length >= 7 ? digits : "";
}

function getDomain(value: unknown) {
  const raw = stringValue(value).trim();

  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getStreetNumber(value: unknown) {
  return stringValue(value).match(/\d+/)?.[0] ?? "";
}

function isStrongNameMatch(leftName: string, rightName: string) {
  return Boolean(
    leftName &&
      rightName &&
      (leftName === rightName || tokenOverlap(leftName, rightName) >= 0.85),
  );
}

function tokenOverlap(leftName: string, rightName: string) {
  const leftTokens = new Set(leftName.split(" ").filter((token) => token.length > 1));
  const rightTokens = new Set(rightName.split(" ").filter((token) => token.length > 1));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function hasSameCampusSafety(
  left: ProspectRecord,
  right: ProspectRecord,
  exactNameMatch: boolean,
) {
  const leftStreetNumber = getStreetNumber(left.full_address);
  const rightStreetNumber = getStreetNumber(right.full_address);

  if (
    leftStreetNumber &&
    rightStreetNumber &&
    leftStreetNumber !== rightStreetNumber &&
    !exactNameMatch
  ) {
    return false;
  }

  return true;
}

function normalizeArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function isBlank(value: unknown) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function getTimestamp(value: unknown) {
  const parsed = Date.parse(stringValue(value));
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function idKey(value: string | number) {
  return String(value);
}

function pairKey(left: string | number, right: string | number) {
  const keys = [idKey(left), idKey(right)].sort();
  return `${keys[0]}:${keys[1]}`;
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  constructor(keys: string[]) {
    for (const key of keys) {
      this.parent.set(key, key);
    }
  }

  find(key: string): string {
    const parent = this.parent.get(key) ?? key;

    if (parent === key) {
      return key;
    }

    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  union(left: string, right: string) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);

    if (leftRoot !== rightRoot) {
      this.parent.set(rightRoot, leftRoot);
    }
  }
}
