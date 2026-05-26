import type { SupabaseClient } from "@supabase/supabase-js";

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

type ProspectContactRecord = Record<string, unknown> & {
  id: string | number;
  prospect_id?: string | number | null;
};

type RunMembershipRecord = {
  run_id?: string | null;
  prospect_id?: string | number | null;
  google_place_id?: string | null;
};

type GroupResult = {
  canonical_prospect_id: string | number;
  canonical_school_name: string;
  duplicate_ids: Array<string | number>;
  duplicate_school_names: string[];
  contacts_moved_or_merged: number;
  run_memberships_moved_or_merged: number;
  error?: string;
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
  "company_domain_name",
  "company_owner",
  "street_address",
  "state_region_code",
  "postal_code",
  "time_zone",
  "industry",
  "company_type",
  "record_source",
  "religion",
  "school_structure",
  "school_structure_boy_girl",
  "school_structure_day_boarding",
  "school_divisions",
  "low_grade",
  "high_grade",
  "number_of_students",
  "number_of_clubs",
  "list_of_clubs",
  "clubs_letter_grade",
  "percent_clubs_get_funding",
  "percent_lots_of_participation",
  "percent_plenty_of_clubs",
  "tuition",
  "niche_ranking",
  "number_of_employees_range",
  "annual_revenue",
  "subscription_year",
  "description",
  "linkedin_company_page",
  "reference_school",
  "reference_school_reason",
  "ai_fit_reason",
  "source_url",
  "data_confidence",
  "export_notes",
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
        contacts_moved_or_merged: 0,
        run_memberships_moved_or_merged: 0,
        active_prospects_remaining: 0,
        per_group_results: [],
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
        contacts_moved_or_merged: 0,
        run_memberships_moved_or_merged: 0,
        active_prospects_remaining: prospects.length,
        per_group_results: [],
        message: "No duplicates found.",
      });
    }

    let canonicalRecordsUpdated = 0;
    let contactsMovedOrMerged = 0;
    let runMembershipsMovedOrMerged = 0;
    const groupResults: GroupResult[] = [];

    for (const group of groups) {
      const groupResult: GroupResult = {
        canonical_prospect_id: group.canonical.id,
        canonical_school_name: stringValue(group.canonical.school_name),
        duplicate_ids: group.duplicates.map((duplicate) => duplicate.id),
        duplicate_school_names: group.duplicates.map((duplicate) =>
          stringValue(duplicate.school_name),
        ),
        contacts_moved_or_merged: 0,
        run_memberships_moved_or_merged: 0,
      };
      const merged = buildCanonicalMerge(group.canonical, group.duplicates);

      if (Object.keys(merged).length > 0) {
        const { error: updateError } = await supabase
          .from("prospects")
          .update(merged)
          .eq("id", group.canonical.id);

        if (updateError) {
          return jsonError("Canonical update failure.", 500);
        }

        canonicalRecordsUpdated += 1;
      }

      try {
        const relationshipResult = await preserveDuplicateRelationships(
          supabase,
          group,
        );

        groupResult.contacts_moved_or_merged =
          relationshipResult.contactsMovedOrMerged;
        groupResult.run_memberships_moved_or_merged =
          relationshipResult.runMembershipsMovedOrMerged;
        contactsMovedOrMerged += relationshipResult.contactsMovedOrMerged;
        runMembershipsMovedOrMerged +=
          relationshipResult.runMembershipsMovedOrMerged;
      } catch (relationshipError) {
        groupResult.error = getErrorMessage(relationshipError);
        groupResults.push(groupResult);

        return Response.json(
          {
            error: "Duplicate relationship preservation failure.",
            total_checked: prospects.length,
            duplicate_groups_found: groups.length,
            duplicates_moved: 0,
            canonical_records_updated: canonicalRecordsUpdated,
            contacts_moved_or_merged: contactsMovedOrMerged,
            run_memberships_moved_or_merged: runMembershipsMovedOrMerged,
            active_prospects_remaining: prospects.length,
            per_group_results: groupResults,
          },
          { status: 500 },
        );
      }

      groupResults.push(groupResult);
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

    const { error: deleteRunMembershipsError } = await supabase
      .from("prospect_run_prospects")
      .delete()
      .in("prospect_id", duplicateIds);

    if (deleteRunMembershipsError) {
      return jsonError("Duplicate run membership delete failure.", 500);
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
      contacts_moved_or_merged: contactsMovedOrMerged,
      run_memberships_moved_or_merged: runMembershipsMovedOrMerged,
      active_prospects_remaining: activeProspectsRemaining,
      per_group_results: groupResults,
      message: `Moved ${duplicateIds.length} duplicates into prospects_duplicates. Merged ${contactsMovedOrMerged} contacts and ${runMembershipsMovedOrMerged} run memberships. ${activeProspectsRemaining} active prospects remain.`,
    });
  } catch (error) {
    if (error instanceof MissingServerEnvError) {
      return jsonError(`Missing ${error.envName}`, 500);
    }

    return jsonError("Unexpected server error.", 500);
  }
}

async function preserveDuplicateRelationships(
  supabase: SupabaseClient,
  group: DuplicateGroup,
) {
  let contactsMovedOrMerged = 0;
  let runMembershipsMovedOrMerged = 0;

  for (const duplicate of group.duplicates) {
    contactsMovedOrMerged += await moveOrMergeDuplicateContacts(
      supabase,
      group.canonical.id,
      duplicate.id,
    );
    runMembershipsMovedOrMerged += await moveOrMergeRunMemberships(
      supabase,
      group.canonical.id,
      duplicate.id,
    );
  }

  await recomputeCanonicalContactRanks(supabase, group.canonical.id);

  return { contactsMovedOrMerged, runMembershipsMovedOrMerged };
}

async function moveOrMergeDuplicateContacts(
  supabase: SupabaseClient,
  canonicalProspectId: string | number,
  duplicateProspectId: string | number,
) {
  const { data: canonicalContacts, error: canonicalError } = await supabase
    .from("prospect_contacts")
    .select("*")
    .eq("prospect_id", canonicalProspectId)
    .limit(10_000);

  if (canonicalError) {
    throw new Error("Unable to load canonical contacts.");
  }

  const { data: duplicateContacts, error: duplicateError } = await supabase
    .from("prospect_contacts")
    .select("*")
    .eq("prospect_id", duplicateProspectId)
    .limit(10_000);

  if (duplicateError) {
    throw new Error("Unable to load duplicate contacts.");
  }

  const canonicalByKey = new Map<string, ProspectContactRecord>();

  for (const contact of (canonicalContacts ?? []) as ProspectContactRecord[]) {
    const key = getContactDedupeKey(contact);

    if (key) {
      canonicalByKey.set(key, contact);
    }
  }

  let movedOrMerged = 0;

  for (const duplicateContact of (duplicateContacts ?? []) as ProspectContactRecord[]) {
    const key = getContactDedupeKey(duplicateContact);
    const canonicalContact = key ? canonicalByKey.get(key) : null;

    if (canonicalContact) {
      const merged = buildContactMerge(canonicalContact, duplicateContact);

      if (Object.keys(merged).length > 0) {
        const { error: mergeError } = await supabase
          .from("prospect_contacts")
          .update(merged)
          .eq("id", canonicalContact.id);

        if (mergeError) {
          throw new Error("Unable to merge duplicate contact.");
        }
      }

      const { error: deleteError } = await supabase
        .from("prospect_contacts")
        .delete()
        .eq("id", duplicateContact.id);

      if (deleteError) {
        throw new Error("Unable to remove merged duplicate contact.");
      }

      movedOrMerged += 1;
      continue;
    }

    const { error: moveError } = await supabase
      .from("prospect_contacts")
      .update({ prospect_id: canonicalProspectId })
      .eq("id", duplicateContact.id);

    if (moveError) {
      throw new Error("Unable to move duplicate contact.");
    }

    if (key) {
      canonicalByKey.set(key, {
        ...duplicateContact,
        prospect_id: canonicalProspectId,
      });
    }

    movedOrMerged += 1;
  }

  return movedOrMerged;
}

async function moveOrMergeRunMemberships(
  supabase: SupabaseClient,
  canonicalProspectId: string | number,
  duplicateProspectId: string | number,
) {
  const { data: memberships, error } = await supabase
    .from("prospect_run_prospects")
    .select("run_id, prospect_id, google_place_id")
    .eq("prospect_id", duplicateProspectId)
    .limit(10_000);

  if (error) {
    throw new Error("Unable to load duplicate run memberships.");
  }

  let movedOrMerged = 0;

  for (const membership of (memberships ?? []) as RunMembershipRecord[]) {
    if (!membership.run_id) {
      continue;
    }

    const { error: upsertError } = await supabase
      .from("prospect_run_prospects")
      .upsert(
        {
          run_id: membership.run_id,
          prospect_id: canonicalProspectId,
          google_place_id: membership.google_place_id ?? null,
        },
        { onConflict: "run_id,prospect_id" },
      );

    if (upsertError) {
      throw new Error("Unable to move duplicate run membership.");
    }

    movedOrMerged += 1;
  }

  return movedOrMerged;
}

async function recomputeCanonicalContactRanks(
  supabase: SupabaseClient,
  canonicalProspectId: string | number,
) {
  const { data, error } = await supabase
    .from("prospect_contacts")
    .select("*")
    .eq("prospect_id", canonicalProspectId)
    .order("contact_rank", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(10_000);

  if (error) {
    throw new Error("Unable to load canonical contacts for rank repair.");
  }

  const contacts = ((data ?? []) as ProspectContactRecord[]).sort(compareContactsForRank);

  for (const [index, contact] of contacts.entries()) {
    const { error: updateError } = await supabase
      .from("prospect_contacts")
      .update({
        contact_rank: index + 1,
        sequence_pick: index === 0,
      })
      .eq("id", contact.id);

    if (updateError) {
      throw new Error("Unable to repair canonical contact ranks.");
    }
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

function buildContactMerge(
  canonical: ProspectContactRecord,
  duplicate: ProspectContactRecord,
) {
  const merged: Record<string, unknown> = {};
  const fillFields = [
    "first_name",
    "last_name",
    "email",
    "phone_number",
    "job_title",
    "contact_owner",
    "lead_status",
    "sequence_name",
    "best_contact_reason",
    "contact_source_url",
    "contact_confidence",
  ];

  for (const field of fillFields) {
    if (!isBlank(canonical[field])) {
      continue;
    }

    if (!isBlank(duplicate[field])) {
      merged[field] = duplicate[field];
    }
  }

  const betterStatus = getBetterValidationStatus(
    canonical.email_validation_status,
    duplicate.email_validation_status,
  );

  if (
    betterStatus &&
    normalizeValidationStatus(betterStatus) !==
      normalizeValidationStatus(canonical.email_validation_status)
  ) {
    merged.email_validation_status = betterStatus;
  }

  const mergedNotes = mergeNotes(canonical.notes, duplicate.notes);

  if (mergedNotes && mergedNotes !== stringValue(canonical.notes)) {
    merged.notes = mergedNotes;
  }

  return merged;
}

function getContactDedupeKey(contact: ProspectContactRecord) {
  const email = normalizeEmail(contact.email);

  if (email) {
    return `email:${email}`;
  }

  const nameTitle = [
    normalizeText(contact.first_name),
    normalizeText(contact.last_name),
    normalizeText(contact.job_title),
  ]
    .filter(Boolean)
    .join("|");

  return nameTitle ? `name-title:${nameTitle}` : "";
}

function compareContactsForRank(
  left: ProspectContactRecord,
  right: ProspectContactRecord,
) {
  if (Boolean(left.sequence_pick) !== Boolean(right.sequence_pick)) {
    return left.sequence_pick ? -1 : 1;
  }

  const rankDifference =
    numberValue(left.contact_rank) - numberValue(right.contact_rank);

  if (rankDifference !== 0) {
    return rankDifference;
  }

  const emailDifference =
    Number(Boolean(normalizeEmail(right.email))) -
    Number(Boolean(normalizeEmail(left.email)));

  if (emailDifference !== 0) {
    return emailDifference;
  }

  return getTimestamp(left.created_at) - getTimestamp(right.created_at);
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

function normalizeEmail(value: unknown) {
  return stringValue(value)
    .toLowerCase()
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
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

function mergeNotes(left: unknown, right: unknown) {
  return uniqueStrings([stringValue(left), stringValue(right)].filter(Boolean)).join(
    " ",
  );
}

function getBetterValidationStatus(left: unknown, right: unknown) {
  const leftStatus = stringValue(left);
  const rightStatus = stringValue(right);

  return getValidationStatusPriority(rightStatus) >
    getValidationStatusPriority(leftStatus)
    ? rightStatus
    : leftStatus;
}

function getValidationStatusPriority(value: unknown) {
  const normalized = normalizeValidationStatus(value);

  if (normalized === "valid") return 4;
  if (normalized === "invalid") return 3;
  if (normalized === "error") return 2;
  if (normalized === "unknown") return 1;

  return 0;
}

function normalizeValidationStatus(value: unknown) {
  return stringValue(value).toLowerCase();
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

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number.parseInt(stringValue(value), 10);

  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error.";
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
