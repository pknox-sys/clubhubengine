const BAD_EMAIL_VALUES = new Set([
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "-",
  "invalid",
]);

const EMPLOYEE_RANGES = new Set([
  "1-5",
  "5-25",
  "25-50",
  "50-100",
  "100-500",
  "500-1000",
  "1000-5000",
  "5000-10000",
  "10000+",
]);

export function stringValue(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  return "";
}

export function normalizeEmail(value: unknown) {
  const raw = stringValue(value).toLowerCase();

  if (!raw || BAD_EMAIL_VALUES.has(raw)) {
    return "";
  }

  return raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
}

export function normalizeDomain(...values: unknown[]) {
  for (const value of values) {
    const raw = stringValue(value);

    if (!raw) {
      continue;
    }

    try {
      const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
      const domain = url.hostname.toLowerCase().replace(/^www\./, "");

      if (domain.includes(".")) {
        return domain;
      }
    } catch {
      continue;
    }
  }

  return "";
}

export function normalizeSchoolType(value: unknown) {
  const normalized = stringValue(value).toLowerCase();

  if (normalized.includes("private")) return "Private";
  if (normalized.includes("charter")) return "Charter";
  if (normalized.includes("public")) return "Public";

  return "";
}

export function normalizeReligion(value: unknown) {
  const normalized = stringValue(value).toLowerCase();

  if (!normalized) return "";

  if (
    ["non-sectarian", "nonsectarian", "none listed", "unknown", "none"].some(
      (item) => normalized.includes(item),
    )
  ) {
    return "";
  }

  if (normalized.includes("jewish") || normalized.includes("hebrew")) {
    return "Jewish";
  }

  if (
    [
      "christian",
      "catholic",
      "lutheran",
      "episcopal",
      "quaker",
      "jesuit",
      "sacred heart",
      "ursuline",
    ].some((item) => normalized.includes(item))
  ) {
    return "Christian";
  }

  return "Other";
}

export function normalizeSchoolStructureBoyGirl(value: unknown) {
  const normalized = stringValue(value).toLowerCase().replace(/[-_]+/g, " ");

  if (normalized.includes("all boys") || normalized.includes("boys only")) {
    return "All Boys";
  }

  if (normalized.includes("all girls") || normalized.includes("girls only")) {
    return "All Girls";
  }

  return "";
}

export function normalizeSchoolDivisions(value: unknown) {
  const normalized = stringValue(value).toLowerCase();
  const divisions: string[] = [];

  if (normalized.includes("lower school") || normalized.includes("lower")) {
    divisions.push("Lower");
  }

  if (normalized.includes("middle school") || normalized.includes("middle")) {
    divisions.push("Middle");
  }

  if (
    normalized.includes("upper school") ||
    normalized.includes("high school") ||
    normalized.includes("upper")
  ) {
    divisions.push("Upper");
  }

  return Array.from(new Set(divisions)).join(";");
}

export function normalizeEmployeeRange(value: unknown) {
  const raw = stringValue(value).replace(/\s+/g, "");

  if (EMPLOYEE_RANGES.has(raw)) {
    return raw;
  }

  return "";
}

export function normalizeNumber(value: unknown) {
  const raw = stringValue(value).replace(/[$,%\s,]+/g, "");

  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) {
    return "";
  }

  return raw;
}

export function normalizeEmailValidationStatus(value: unknown) {
  const normalized = stringValue(value).toLowerCase();

  if (normalized.includes("invalid") || normalized === "failed") {
    return "Invalid";
  }

  if (normalized.includes("valid") || normalized === "passed") {
    return "Valid";
  }

  if (normalized.includes("error")) {
    return "Error";
  }

  return "Unknown";
}

export function splitName(value: unknown) {
  const clean = stringValue(value).replace(/\s+/g, " ").trim();

  if (!clean) {
    return { firstName: "", lastName: "" };
  }

  const [firstName, ...rest] = clean.split(" ");

  return {
    firstName,
    lastName: rest.join(" "),
  };
}

export function csvEscape(value: unknown) {
  const raw = stringValue(value);

  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }

  return raw;
}
