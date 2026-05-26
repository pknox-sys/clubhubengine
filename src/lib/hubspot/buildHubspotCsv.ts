import {
  HUBSPOT_EXPORT_HEADERS,
  type HubSpotExportHeader,
} from "@/lib/hubspot/exportHeaders";
import {
  csvEscape,
  normalizeDomain,
  normalizeEmail,
  normalizeEmailValidationStatus,
  normalizeEmployeeRange,
  normalizeNumber,
  normalizeReligion,
  normalizeSchoolDivisions,
  normalizeSchoolStructureBoyGirl,
  normalizeSchoolType,
  splitName,
  stringValue,
} from "@/lib/hubspot/normalizers";

export type ProspectExportRecord = Record<string, unknown> & {
  id: string | number;
};

export type ProspectContactExportRecord = Record<string, unknown> & {
  prospect_id?: string | number | null;
};

type BuildHubspotCsvOptions = {
  includeBlockedRows?: boolean;
};

type ExportContact = {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  jobTitle: string;
  contactOwner: string;
  leadStatus: string;
  contactRank: number;
  sequenceName: string;
  bestContactReason: string;
  emailValidationStatus: "Valid" | "Unknown" | "Error" | "Invalid";
  contactSourceUrl: string;
  contactConfidence: string;
  notes: string;
  createdAt: string;
};

const DEFAULT_CONTACT_OWNER = "Paul Knox";
const DEFAULT_COMPANY_OWNER = "Paul Knox";
const DEFAULT_LEAD_STATUS = "New";
const DEFAULT_RECORD_SOURCE = "Import";
const DEFAULT_INDUSTRY = "Education Management";
const DEFAULT_SEQUENCE_NAME = "Club Hub - V1 School Outreach";

export function buildHubspotCsv(
  prospects: ProspectExportRecord[],
  options: BuildHubspotCsvOptions = {},
) {
  const builtRows = prospects.flatMap((prospect) =>
    buildRowsForProspect(prospect, options),
  );
  const rows = options.includeBlockedRows
    ? builtRows
    : uniqueRowsByEmail(builtRows);
  const csvRows = [
    HUBSPOT_EXPORT_HEADERS.map(csvEscape).join(","),
    ...rows.map((row) =>
      HUBSPOT_EXPORT_HEADERS.map((header) => csvEscape(row[header])).join(","),
    ),
  ];

  return `${csvRows.join("\r\n")}\r\n`;
}

function buildRowsForProspect(
  prospect: ProspectExportRecord,
  options: BuildHubspotCsvOptions,
) {
  const companyName = stringValue(prospect.school_name);
  const companyDomain = normalizeDomain(
    prospect.company_domain_name,
    prospect.website,
    prospect.source_url,
  );

  if (!options.includeBlockedRows && (!companyName || !companyDomain)) {
    return [];
  }

  const contacts = getContactsForProspect(prospect)
    .map((contact, index) =>
      normalizeContact(contact, prospect, index, options),
    )
    .filter(
      (contact): contact is ExportContact =>
        contact !== null &&
        (options.includeBlockedRows ||
          contact.emailValidationStatus !== "Invalid"),
    )
    .map((contact) =>
      options.includeBlockedRows
        ? addBlockedRowNotes(contact, {
            companyName,
            companyDomain,
          })
        : contact,
    )
    .sort(compareContacts);

  let hasSequencePick = false;

  return contacts.map((contact) => {
    const sequencePick = contact.contactRank === 1 && !hasSequencePick;

    if (sequencePick) {
      hasSequencePick = true;
    }

    return buildHubSpotRow(prospect, contact, {
      companyName,
      companyDomain,
      sequencePick,
    });
  });
}

function getContactsForProspect(prospect: ProspectExportRecord) {
  const joinedContacts = prospect.prospect_contacts;

  if (Array.isArray(joinedContacts) && joinedContacts.length > 0) {
    return joinedContacts.filter(isRecord);
  }

  if (normalizeEmail(prospect.contact_email)) {
    return [
      {
        first_name: splitName(prospect.contact_name).firstName,
        last_name: splitName(prospect.contact_name).lastName,
        email: prospect.contact_email,
        phone_number: prospect.contact_phone || prospect.main_phone,
        job_title: prospect.contact_title,
        contact_owner: DEFAULT_CONTACT_OWNER,
        lead_status: DEFAULT_LEAD_STATUS,
        contact_rank: 1,
        sequence_name: DEFAULT_SEQUENCE_NAME,
        email_validation_status:
          prospect.email_validation_status ??
          prospect.contact_email_validation_status ??
          "Unknown",
        contact_source_url: prospect.contact_source_url,
        contact_confidence: prospect.contact_confidence,
      },
    ];
  }

  return [
    {
      first_name: "",
      last_name: "",
      email: prospect.contact_email,
      phone_number: prospect.contact_phone || prospect.main_phone,
      job_title: prospect.contact_title,
      contact_owner: DEFAULT_CONTACT_OWNER,
      lead_status: DEFAULT_LEAD_STATUS,
      contact_rank: 1,
      sequence_name: DEFAULT_SEQUENCE_NAME,
      email_validation_status:
        prospect.email_validation_status ??
        prospect.contact_email_validation_status ??
        "Unknown",
      best_contact_reason:
        "Fallback row for selected prospect; no named exportable contact was found.",
      contact_source_url: prospect.contact_source_url,
      contact_confidence: prospect.contact_confidence,
      notes:
        "Selected prospect exported with missing contact data; verify before HubSpot import.",
    },
  ];
}

function normalizeContact(
  contact: Record<string, unknown>,
  prospect: ProspectExportRecord,
  index: number,
  options: BuildHubspotCsvOptions,
): ExportContact | null {
  const legacyName = splitName(prospect.contact_name);
  const firstName = stringValue(contact.first_name) || legacyName.firstName;
  const lastName = stringValue(contact.last_name) || legacyName.lastName;
  const email = normalizeEmail(contact.email);

  if (!email && !options.includeBlockedRows) {
    return null;
  }

  return {
    firstName,
    lastName,
    email,
    phoneNumber: stringValue(contact.phone_number),
    jobTitle: stringValue(contact.job_title),
    contactOwner: stringValue(contact.contact_owner) || DEFAULT_CONTACT_OWNER,
    leadStatus: stringValue(contact.lead_status) || DEFAULT_LEAD_STATUS,
    contactRank: normalizeContactRank(contact.contact_rank, index),
    sequenceName: stringValue(contact.sequence_name) || DEFAULT_SEQUENCE_NAME,
    bestContactReason: stringValue(contact.best_contact_reason),
    emailValidationStatus: normalizeEmailValidationStatus(
      contact.email_validation_status ||
        prospect.email_validation_status ||
        prospect.contact_email_validation_status,
    ),
    contactSourceUrl: stringValue(contact.contact_source_url),
    contactConfidence: stringValue(contact.contact_confidence),
    notes: stringValue(contact.notes),
    createdAt: stringValue(contact.created_at),
  };
}

function addBlockedRowNotes(
  contact: ExportContact,
  values: { companyName: string; companyDomain: string },
) {
  const blockerNotes: string[] = [];

  if (!contact.email) {
    blockerNotes.push("Missing contact email.");
  }

  if (contact.emailValidationStatus === "Invalid") {
    blockerNotes.push("Email marked Invalid.");
  }

  if (!values.companyName) {
    blockerNotes.push("Missing company name.");
  }

  if (!values.companyDomain) {
    blockerNotes.push("Missing company domain.");
  }

  if (blockerNotes.length === 0) {
    return contact;
  }

  return {
    ...contact,
    notes: [contact.notes, `Export blocker: ${blockerNotes.join(" ")}`]
      .filter(Boolean)
      .join(" "),
  };
}

function buildHubSpotRow(
  prospect: ProspectExportRecord,
  contact: ExportContact,
  options: {
    companyName: string;
    companyDomain: string;
    sequencePick: boolean;
  },
): Record<HubSpotExportHeader, string> {
  const sourceUrl =
    stringValue(prospect.source_url) ||
    contact.contactSourceUrl ||
    firstArrayString(prospect.source_urls) ||
    stringValue(prospect.website) ||
    stringValue(prospect.google_maps_url);
  const dataConfidence =
    stringValue(prospect.data_confidence) || contact.contactConfidence;
  const notes = [stringValue(prospect.export_notes), contact.notes]
    .filter(Boolean)
    .join(" ");

  return {
    "First Name": contact.firstName,
    "Last Name": contact.lastName,
    Email: contact.email,
    "Phone Number": contact.phoneNumber,
    "Job Title": contact.jobTitle,
    "Contact owner": contact.contactOwner,
    "Lead Status": contact.leadStatus,
    "Contact Rank": String(contact.contactRank),
    "Sequence Pick": options.sequencePick ? "TRUE" : "FALSE",
    "Sequence Name": contact.sequenceName,
    "Best Contact Reason": contact.bestContactReason,
    "Email Validation Status": contact.emailValidationStatus,
    "Company Name": options.companyName,
    "Company Domain Name": options.companyDomain,
    "Company Phone Number": stringValue(prospect.main_phone),
    "Company owner": stringValue(prospect.company_owner) || DEFAULT_COMPANY_OWNER,
    "Street Address":
      stringValue(prospect.street_address) || stringValue(prospect.full_address),
    City: stringValue(prospect.city),
    "State/Region": stringValue(prospect.state),
    "State/Region Code":
      stringValue(prospect.state_region_code) || stringValue(prospect.state),
    "Postal Code": stringValue(prospect.postal_code),
    "Time Zone": "",
    Industry: stringValue(prospect.industry) || DEFAULT_INDUSTRY,
    Type: stringValue(prospect.company_type),
    "Record source": stringValue(prospect.record_source) || DEFAULT_RECORD_SOURCE,
    "School Type": normalizeSchoolType(prospect.school_type),
    Religion: normalizeReligion(prospect.religion),
    "School Structure": stringValue(prospect.school_structure),
    "School Structure Boy/Girl": normalizeSchoolStructureBoyGirl(
      prospect.school_structure_boy_girl,
    ),
    "School Structure Day/Boarding": stringValue(
      prospect.school_structure_day_boarding,
    ),
    "School Divisions": normalizeSchoolDivisions(prospect.school_divisions),
    "Low Grade": stringValue(prospect.low_grade),
    "High Grade": stringValue(prospect.high_grade),
    "# of Students":
      normalizeNumber(prospect.number_of_students) ||
      normalizeNumber(prospect.total_enrollment) ||
      normalizeNumber(prospect.hs_enrollment),
    "# of Clubs":
      normalizeNumber(prospect.number_of_clubs) ||
      normalizeNumber(prospect.clubs_count_estimate),
    "List of Clubs": stringValue(prospect.list_of_clubs),
    "Clubs Letter Grade": stringValue(prospect.clubs_letter_grade),
    "% Clubs Get Funding": normalizeNumber(prospect.percent_clubs_get_funding),
    "% Lots of Participation": normalizeNumber(
      prospect.percent_lots_of_participation,
    ),
    "% Plenty of Clubs": normalizeNumber(prospect.percent_plenty_of_clubs),
    Tuition: normalizeNumber(prospect.tuition),
    "Niche Ranking": stringValue(prospect.niche_ranking),
    "Number of Employees": normalizeEmployeeRange(
      prospect.number_of_employees_range,
    ),
    "Annual Revenue": normalizeNumber(prospect.annual_revenue),
    "Subscription Year": stringValue(prospect.subscription_year),
    Description:
      stringValue(prospect.description) || stringValue(prospect.research_notes),
    "LinkedIn Company Page": stringValue(prospect.linkedin_company_page),
    "Reference School": stringValue(prospect.reference_school),
    "Reference School Reason": stringValue(prospect.reference_school_reason),
    "AI Fit Reason":
      stringValue(prospect.ai_fit_reason) ||
      stringValue(prospect.personalization_angle),
    "Source URL": sourceUrl,
    "Data Confidence": dataConfidence,
    Notes: notes,
  };
}

function normalizeContactRank(value: unknown, index: number) {
  const numeric =
    typeof value === "number"
      ? value
      : Number.parseInt(stringValue(value), 10);

  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }

  return index + 1;
}

function compareContacts(left: ExportContact, right: ExportContact) {
  const rankDifference = left.contactRank - right.contactRank;

  if (rankDifference !== 0) {
    return rankDifference;
  }

  return left.createdAt.localeCompare(right.createdAt);
}

function firstArrayString(value: unknown) {
  if (!Array.isArray(value)) {
    return "";
  }

  return value.find((item) => typeof item === "string" && item.trim()) ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueRowsByEmail(
  rows: Array<Record<HubSpotExportHeader, string>>,
) {
  const seenEmails = new Set<string>();
  const uniqueRows: Array<Record<HubSpotExportHeader, string>> = [];

  for (const row of rows) {
    const email = row.Email.toLowerCase();

    if (!email) {
      uniqueRows.push(row);
      continue;
    }

    if (seenEmails.has(email)) {
      continue;
    }

    seenEmails.add(email);
    uniqueRows.push(row);
  }

  return uniqueRows;
}
