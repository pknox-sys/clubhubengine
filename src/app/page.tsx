"use client";

import { Fragment, FormEvent, useCallback, useEffect, useState } from "react";

import type { ProspectContactListItem, ProspectListItem } from "@/types/prospect";

type ProspectsResponse = {
  prospects?: ProspectListItem[];
  count?: number;
  run_id?: string;
  run_name?: string;
  error?: string;
};

type RunsResponse = {
  runs?: ProspectRun[];
  error?: string;
};

type ProspectRun = {
  id: string;
  name: string;
  keyword: string;
  city: string;
  state: string;
  result_count: number;
  saved_count: number;
  status: string;
  created_at: string;
};

type EnrichResponse = {
  attempted?: number;
  enriched?: number;
  failed?: number;
  skipped?: number;
  message?: string;
  results?: EnrichResultItem[];
  error?: string;
};

type EnrichResultItem = {
  id?: string | number;
  prospect_id?: string | number;
  school_name?: string;
  status?: "enriched" | "enrichment_failed" | "skipped";
  contacts_returned?: number;
  contacts_written?: number;
  contacts_with_email?: number;
  contacts_without_email?: number;
  contacts_dropped?: number;
  best_contact_name?: string | null;
  best_contact_email?: string | null;
  prospect_update_success?: boolean;
  contact_upsert_success?: boolean;
  error?: string;
};

type EnrichmentPanel = {
  scope: string;
  message: string;
  attempted: number;
  enriched: number;
  failed: number;
  skipped: number;
  results: EnrichResultItem[];
};

type ActionResponse = {
  message?: string;
  error?: string;
};

type ProspectFilters = {
  city: string;
  state: string;
  schoolType: string;
  enrichmentStatus: string;
  emailValidationStatus: string;
  sequencePick: string;
  contactRank: string;
  dataConfidence: string;
  hasEmail: string;
};

const DEFAULT_KEYWORD = "private high school";
const DEFAULT_CITY = "Chicago";
const DEFAULT_STATE = "IL";
const EMPTY_FILTERS: ProspectFilters = {
  city: "",
  state: "",
  schoolType: "",
  enrichmentStatus: "",
  emailValidationStatus: "",
  sequencePick: "",
  contactRank: "",
  dataConfidence: "",
  hasEmail: "",
};

export default function Home() {
  const [keyword, setKeyword] = useState(DEFAULT_KEYWORD);
  const [city, setCity] = useState(DEFAULT_CITY);
  const [state, setState] = useState(DEFAULT_STATE);
  const [runs, setRuns] = useState<ProspectRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [filters, setFilters] = useState<ProspectFilters>(EMPTY_FILTERS);
  const [prospects, setProspects] = useState<ProspectListItem[]>([]);
  const [selectedProspectIds, setSelectedProspectIds] = useState<Set<string>>(
    new Set(),
  );
  const [expandedProspectIds, setExpandedProspectIds] = useState<Set<string>>(
    new Set(),
  );
  const [enrichmentPanel, setEnrichmentPanel] =
    useState<EnrichmentPanel | null>(null);
  const [isLoadingRecent, setIsLoadingRecent] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [isDedupeRunning, setIsDedupeRunning] = useState(false);
  const [isEmailValidationRunning, setIsEmailValidationRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function setVisibleProspects(nextProspects: ProspectListItem[]) {
    const visibleIds = new Set(
      nextProspects.map((prospect) => idKey(prospect.id)),
    );

    setProspects(nextProspects);
    setSelectedProspectIds(
      (current) => new Set(Array.from(current).filter((id) => visibleIds.has(id))),
    );
    setExpandedProspectIds(
      (current) => new Set(Array.from(current).filter((id) => visibleIds.has(id))),
    );
  }

  const loadRuns = useCallback(async () => {
    setRuns(await fetchRuns());
  }, []);

  const loadProspects = useCallback(
    async (nextRunId = selectedRunId, nextFilters = filters) => {
      setVisibleProspects(await fetchRecentProspects(nextRunId, nextFilters));
    },
    [filters, selectedRunId],
  );

  const loadRecentProspects = useCallback(async () => {
    setIsLoadingRecent(true);
    setError("");

    try {
      setSelectedRunId("");
      setFilters(EMPTY_FILTERS);
      setVisibleProspects(await fetchRecentProspects("", EMPTY_FILTERS));
      setSelectedProspectIds(new Set());
      setMessage("");
    } catch (loadError) {
      setError(getReadableError(loadError));
    } finally {
      setIsLoadingRecent(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadInitialData() {
      try {
        const [loadedRuns, loadedProspects] = await Promise.all([
          fetchRuns(),
          fetchRecentProspects("", EMPTY_FILTERS),
        ]);

        if (isMounted) {
          setRuns(loadedRuns);
          setVisibleProspects(loadedProspects);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(getReadableError(loadError));
        }
      }
    }

    void loadInitialData();

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSearching(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/prospects/google-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ keyword, city, state }),
      });
      const payload = (await response.json()) as ProspectsResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to save prospects.");
      }

      await loadRuns();

      if (payload.run_id) {
        setSelectedRunId(payload.run_id);
        setVisibleProspects(await fetchRecentProspects(payload.run_id, filters));
      } else {
        setVisibleProspects(payload.prospects ?? []);
      }

      setSelectedProspectIds(new Set());
      setMessage(
        `${payload.count ?? payload.prospects?.length ?? 0} prospects saved from Google Places.${
          payload.run_name ? ` Run: ${payload.run_name}.` : ""
        }`,
      );
    } catch (searchError) {
      setError(getReadableError(searchError));
    } finally {
      setIsSearching(false);
    }
  }

  async function handleRunChange(runId: string) {
    setSelectedRunId(runId);
    setIsLoadingRecent(true);
    setError("");

    try {
      await loadProspects(runId, filters);
      setMessage("");
    } catch (loadError) {
      setError(getReadableError(loadError));
    } finally {
      setIsLoadingRecent(false);
    }
  }

  async function handleFilterChange(
    key: keyof ProspectFilters,
    value: string,
  ) {
    const nextFilters = { ...filters, [key]: value };
    setFilters(nextFilters);
    setIsLoadingRecent(true);
    setError("");

    try {
      await loadProspects(selectedRunId, nextFilters);
      setMessage("");
    } catch (loadError) {
      setError(getReadableError(loadError));
    } finally {
      setIsLoadingRecent(false);
    }
  }

  async function runEnrichment(
    body: Record<string, unknown>,
    scope: string,
  ) {
    setIsEnhancing(true);
    setMessage("");
    setError("");
    setEnrichmentPanel({
      scope,
      message: "Enhancement is running...",
      attempted: 0,
      enriched: 0,
      failed: 0,
      skipped: 0,
      results: [],
    });

    try {
      const response = await fetch("/api/prospects/enrich", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as EnrichResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to enhance prospects.");
      }

      await loadProspects();
      setEnrichmentPanel({
        scope,
        message: payload.message ?? "Enhancement completed.",
        attempted: payload.attempted ?? 0,
        enriched: payload.enriched ?? 0,
        failed: payload.failed ?? 0,
        skipped: payload.skipped ?? 0,
        results: payload.results ?? [],
      });
      setMessage(payload.message ?? "Enhancement completed.");
    } catch (enhanceError) {
      setError(getReadableError(enhanceError));
      setEnrichmentPanel((current) =>
        current
          ? {
              ...current,
              message: getReadableError(enhanceError),
              failed: current.failed || 1,
            }
          : current,
      );
    } finally {
      setIsEnhancing(false);
    }
  }

  async function handleEnhance() {
    await runEnrichment({ limit: 5 }, "General unenriched prospects");
  }

  async function handleEnhanceSelectedRows() {
    await runEnrichment(
      { prospectIds: Array.from(selectedProspectIds) },
      `${selectedProspectIds.size} selected rows`,
    );
  }

  async function handleEnhanceCurrentRun() {
    const runName =
      runs.find((run) => run.id === selectedRunId)?.name ?? "Current run";

    await runEnrichment({ runId: selectedRunId }, runName);
  }

  async function handleEnhanceLoadedRows() {
    await runEnrichment(
      { prospectIds: prospects.map((prospect) => idKey(prospect.id)) },
      `${prospects.length} loaded / filtered rows`,
    );
  }

  async function handleDedupe() {
    setIsDedupeRunning(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/prospects/dedupe", {
        method: "POST",
      });
      const payload = (await response.json()) as ActionResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to de-dupe prospects.");
      }

      await loadProspects();
      setMessage(payload.message ?? "De-dupe completed.");
    } catch (dedupeError) {
      setError(getReadableError(dedupeError));
    } finally {
      setIsDedupeRunning(false);
    }
  }

  async function handleValidateEmails() {
    setIsEmailValidationRunning(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/prospects/validate-emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 50 }),
      });
      const payload = (await response.json()) as ActionResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to validate emails.");
      }

      await loadProspects();
      setMessage(payload.message ?? "Email validation completed.");
    } catch (validationError) {
      setError(getReadableError(validationError));
    } finally {
      setIsEmailValidationRunning(false);
    }
  }

  function handleDownloadHubSpotCsv() {
    const params =
      selectedProspectIds.size > 0
        ? new URLSearchParams({
            prospectIds: Array.from(selectedProspectIds).join(","),
          })
        : buildProspectQueryParams(selectedRunId, filters);
    const query = params.toString();

    window.location.href = `/api/prospects/export-hubspot${query ? `?${query}` : ""}`;
  }

  function handleSelectCurrentPage() {
    setSelectedProspectIds(new Set(prospects.map((prospect) => idKey(prospect.id))));
  }

  function handleClearSelection() {
    setSelectedProspectIds(new Set());
  }

  function handleToggleProspect(id: string) {
    setSelectedProspectIds((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  function handleToggleContacts(id: string) {
    setExpandedProspectIds((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  const isLoading =
    isLoadingRecent ||
    isSearching ||
    isEnhancing ||
    isDedupeRunning ||
    isEmailValidationRunning;

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8 text-slate-950">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="border-b border-slate-200 pb-5">
          <h1 className="text-3xl font-semibold tracking-normal">
            Club Hub Prospect Engine V1
          </h1>
          <p className="mt-2 max-w-3xl text-base leading-7 text-slate-600">
            Google Places prospect search for finding and saving school records
            into Supabase.
          </p>
        </header>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <form
            className="grid gap-4 xl:grid-cols-[minmax(220px,1.2fr)_minmax(160px,0.8fr)_100px_repeat(6,minmax(140px,auto))]"
            onSubmit={handleSubmit}
          >
            <TextInput label="Keyword" minLength={2} onChange={setKeyword} value={keyword} />
            <TextInput label="City" minLength={2} onChange={setCity} value={city} />
            <TextInput
              label="State"
              minLength={2}
              onChange={setState}
              value={state}
              uppercase
            />

            <ActionButton disabled={isLoading} primary type="submit">
              {isSearching ? "Searching..." : "Search"}
            </ActionButton>

            <ActionButton disabled={isLoading} onClick={loadRecentProspects}>
              {isLoadingRecent ? "Loading..." : "Load Recent"}
            </ActionButton>

            <ActionButton
              className="bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-emerald-300"
              disabled={isLoading}
              onClick={handleEnhance}
            >
              {isEnhancing ? "Enhancing..." : "Enhance Unenriched Prospects"}
            </ActionButton>

            <ActionButton
              className="bg-indigo-700 text-white hover:bg-indigo-800 disabled:bg-indigo-300"
              disabled={isLoading}
              onClick={handleDedupe}
            >
              {isDedupeRunning ? "De-duping..." : "De-Dupe Prospects"}
            </ActionButton>

            <ActionButton
              className="bg-amber-600 text-white hover:bg-amber-700 disabled:bg-amber-300"
              disabled={isLoading}
              onClick={handleValidateEmails}
            >
              {isEmailValidationRunning ? "Validating..." : "Validate Emails"}
            </ActionButton>

            <div className="flex flex-col justify-end gap-1">
              <ActionButton
                className="bg-sky-700 text-white hover:bg-sky-800 disabled:bg-sky-300"
                disabled={isLoading}
                onClick={handleDownloadHubSpotCsv}
              >
                Download HubSpot CSV
              </ActionButton>
              <p className="text-xs leading-4 text-slate-500">
                Exports selected rows, or current filtered view if none selected.
              </p>
            </div>
          </form>

          <div className="mt-5 grid gap-4 border-t border-slate-200 pt-4 md:grid-cols-2 xl:grid-cols-5">
            <SelectInput
              label="Run"
              onChange={handleRunChange}
              value={selectedRunId}
              options={[
                { label: "All Runs", value: "" },
                ...runs.map((run) => ({
                  label: run.name,
                  value: run.id,
                })),
              ]}
            />
            <TextInput
              label="Filter City"
              onChange={(value) => handleFilterChange("city", value)}
              value={filters.city}
            />
            <TextInput
              label="Filter State"
              onChange={(value) => handleFilterChange("state", value)}
              value={filters.state}
              uppercase
            />
            <SelectInput
              label="School Type"
              onChange={(value) => handleFilterChange("schoolType", value)}
              value={filters.schoolType}
              options={[
                { label: "Any", value: "" },
                { label: "Private", value: "Private" },
                { label: "Charter", value: "Charter" },
                { label: "Public", value: "Public" },
              ]}
            />
            <SelectInput
              label="Enrichment"
              onChange={(value) => handleFilterChange("enrichmentStatus", value)}
              value={filters.enrichmentStatus}
              options={[
                { label: "Any", value: "" },
                { label: "Raw", value: "raw" },
                { label: "Enriched", value: "enriched" },
                { label: "Failed", value: "enrichment_failed" },
              ]}
            />
            <SelectInput
              label="Email Status"
              onChange={(value) =>
                handleFilterChange("emailValidationStatus", value)
              }
              value={filters.emailValidationStatus}
              options={[
                { label: "Any", value: "" },
                { label: "Valid", value: "Valid" },
                { label: "Unknown", value: "Unknown" },
                { label: "Error", value: "Error" },
                { label: "Invalid", value: "Invalid" },
              ]}
            />
            <SelectInput
              label="Sequence Pick"
              onChange={(value) => handleFilterChange("sequencePick", value)}
              value={filters.sequencePick}
              options={[
                { label: "Any", value: "" },
                { label: "TRUE", value: "true" },
                { label: "FALSE", value: "false" },
              ]}
            />
            <TextInput
              label="Contact Rank"
              onChange={(value) => handleFilterChange("contactRank", value)}
              type="number"
              value={filters.contactRank}
            />
            <SelectInput
              label="Confidence"
              onChange={(value) => handleFilterChange("dataConfidence", value)}
              value={filters.dataConfidence}
              options={[
                { label: "Any", value: "" },
                { label: "High", value: "High" },
                { label: "Medium", value: "Medium" },
                { label: "Low", value: "Low" },
              ]}
            />
            <SelectInput
              label="Email"
              onChange={(value) => handleFilterChange("hasEmail", value)}
              value={filters.hasEmail}
              options={[
                { label: "Any", value: "" },
                { label: "Has email", value: "true" },
                { label: "Missing email", value: "false" },
              ]}
            />
          </div>

          <div className="mt-5 flex flex-col gap-3 border-t border-slate-200 pt-4">
            <div className="flex flex-wrap gap-3">
              <ActionButton
                className="bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-emerald-300"
                disabled={isLoading || selectedProspectIds.size === 0}
                onClick={handleEnhanceSelectedRows}
              >
                Enhance Selected Rows
              </ActionButton>
              <ActionButton
                className="bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-emerald-300"
                disabled={isLoading || !selectedRunId}
                onClick={handleEnhanceCurrentRun}
              >
                Enhance Current Run
              </ActionButton>
              <ActionButton
                className="bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-emerald-300"
                disabled={isLoading || prospects.length === 0}
                onClick={handleEnhanceLoadedRows}
              >
                Enhance All Loaded / Filtered Rows
              </ActionButton>
            </div>
            <p className="text-xs leading-5 text-slate-500">
              Scoped enrichment targets selected rows first, then the current
              run or loaded filtered rows. The general enhancement button keeps
              the original unenriched-prospect behavior.
            </p>
          </div>

          <div className="mt-4 min-h-6 text-sm">
            {message ? <p className="text-emerald-700">{message}</p> : null}
            {error ? <p className="text-red-700">{error}</p> : null}
          </div>

          {enrichmentPanel ? (
            <EnrichmentStatusPanel
              isRunning={isEnhancing}
              panel={enrichmentPanel}
            />
          ) : null}
        </section>

        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Saved Prospects</h2>
              <p className="text-sm text-slate-500">
                {isLoading ? "Loading..." : `${prospects.length} loaded`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-slate-600">
                {selectedProspectIds.size} selected
              </span>
              <button
                className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
                onClick={handleSelectCurrentPage}
                type="button"
              >
                Select Current Page
              </button>
              <button
                className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
                onClick={handleClearSelection}
                type="button"
              >
                Clear Selection
              </button>
            </div>
          </div>

          {prospects.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-[2280px] table-fixed border-collapse text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase tracking-normal text-slate-600">
                  <tr>
                    <TableHeader className="w-12">Select</TableHeader>
                    <TableHeader className="w-32">Contacts</TableHeader>
                    <TableHeader className="w-56">School Name</TableHeader>
                    <TableHeader className="w-36">City</TableHeader>
                    <TableHeader className="w-20">State</TableHeader>
                    <TableHeader className="w-40">Phone</TableHeader>
                    <TableHeader className="w-28">Website</TableHeader>
                    <TableHeader className="w-28">Students</TableHeader>
                    <TableHeader className="w-24">Clubs</TableHeader>
                    <TableHeader className="w-56">Best Contact</TableHeader>
                    <TableHeader className="w-44">Contact Title</TableHeader>
                    <TableHeader className="w-48">Contact Email</TableHeader>
                    <TableHeader className="w-36">Email Status</TableHeader>
                    <TableHeader className="w-28">Fit / Confidence</TableHeader>
                    <TableHeader className="w-72">AI Fit Reason</TableHeader>
                    <TableHeader className="w-44">Reference School</TableHeader>
                    <TableHeader className="w-40">Status</TableHeader>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {prospects.map((prospect) => {
                    const id = idKey(prospect.id);
                    const isExpanded = expandedProspectIds.has(id);

                    return (
                      <Fragment key={id}>
                        <tr className="align-top">
                          <TableCell>
                            <input
                              aria-label={`Select ${prospect.school_name || "prospect"}`}
                              checked={selectedProspectIds.has(id)}
                              className="h-4 w-4"
                              onChange={() => handleToggleProspect(id)}
                              type="checkbox"
                            />
                          </TableCell>
                          <TableCell>
                            <button
                              className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                              onClick={() => handleToggleContacts(id)}
                              type="button"
                            >
                              {isExpanded ? "Hide" : "View"} Contacts (
                              {prospect.contact_count ?? 0})
                            </button>
                          </TableCell>
                          <TableCell className="font-medium text-slate-950">
                            {prospect.school_name || "Unknown School"}
                          </TableCell>
                          <TableCell>{prospect.city || "-"}</TableCell>
                          <TableCell>{prospect.state || "-"}</TableCell>
                          <TableCell>{prospect.main_phone || "-"}</TableCell>
                          <TableCell>
                            {prospect.website ? (
                              <a
                                className="font-medium text-blue-700 underline-offset-4 hover:underline"
                                href={prospect.website}
                                rel="noopener noreferrer"
                                target="_blank"
                              >
                                Website
                              </a>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell>{formatEnrollment(prospect)}</TableCell>
                          <TableCell>{formatClubsEstimate(prospect)}</TableCell>
                          <TableCell>{renderBestContact(prospect)}</TableCell>
                          <TableCell>{getBestContactTitle(prospect) || "-"}</TableCell>
                          <TableCell>
                            {getBestContactEmail(prospect) ? (
                              <a
                                className="font-medium text-blue-700 underline-offset-4 hover:underline"
                                href={`mailto:${getBestContactEmail(prospect)}`}
                              >
                                {getBestContactEmail(prospect)}
                              </a>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell>
                            <span>{formatEmailStatus(prospect)}</span>
                            {prospect.email_validation_error ? (
                              <span className="mt-1 block text-xs text-red-700">
                                {prospect.email_validation_error}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>{formatFitScore(prospect)}</TableCell>
                          <TableCell>{formatAiFitReason(prospect)}</TableCell>
                          <TableCell>{prospect.reference_school || "-"}</TableCell>
                          <TableCell>
                            <span>{prospect.enrichment_status || "raw"}</span>
                            {prospect.enrichment_status === "enrichment_failed" &&
                            prospect.enrichment_error ? (
                              <span className="mt-1 block text-xs text-red-700">
                                {prospect.enrichment_error}
                              </span>
                            ) : null}
                          </TableCell>
                        </tr>
                        {isExpanded ? (
                          <tr>
                            <td
                              className="bg-slate-50 px-4 py-4"
                              colSpan={17}
                            >
                              <ContactsDetail contacts={prospect.prospect_contacts ?? []} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-5 py-12 text-center text-sm text-slate-500">
              No prospects loaded yet. Run a Google Places search.
            </div>
          )}
        </section>

        <p className="text-xs text-slate-500">Results powered by Google Maps.</p>
      </div>
    </main>
  );
}

function EnrichmentStatusPanel({
  isRunning,
  panel,
}: {
  isRunning: boolean;
  panel: EnrichmentPanel;
}) {
  return (
    <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="font-semibold text-emerald-950">
            Enrichment Status
          </h3>
          <p className="mt-1 text-emerald-800">
            Scope: {panel.scope}
            {isRunning ? " - running" : ""}
          </p>
        </div>
        <div className="grid grid-cols-4 gap-3 text-center text-xs text-emerald-950">
          <Metric label="Attempted" value={panel.attempted} />
          <Metric label="Enriched" value={panel.enriched} />
          <Metric label="Failed" value={panel.failed} />
          <Metric label="Skipped" value={panel.skipped} />
        </div>
      </div>
      <p className="mt-3 text-emerald-800">{panel.message}</p>
      {panel.results.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-md border border-emerald-200 bg-white">
          <table className="min-w-[1240px] text-left text-xs">
            <thead className="bg-emerald-100 text-emerald-950">
              <tr>
                <TableHeader>School</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Returned</TableHeader>
                <TableHeader>Contacts Written</TableHeader>
                <TableHeader>With Email</TableHeader>
                <TableHeader>No Email</TableHeader>
                <TableHeader>Dropped</TableHeader>
                <TableHeader>Best Contact</TableHeader>
                <TableHeader>Best Email</TableHeader>
                <TableHeader>Error</TableHeader>
              </tr>
            </thead>
            <tbody className="divide-y divide-emerald-100">
              {panel.results.map((result, index) => (
                <tr key={`${result.prospect_id ?? result.id ?? index}`}>
                  <TableCell>{result.school_name || "-"}</TableCell>
                  <TableCell>{result.status || "-"}</TableCell>
                  <TableCell>{result.contacts_returned ?? 0}</TableCell>
                  <TableCell>{result.contacts_written ?? 0}</TableCell>
                  <TableCell>{result.contacts_with_email ?? 0}</TableCell>
                  <TableCell>{result.contacts_without_email ?? 0}</TableCell>
                  <TableCell>{result.contacts_dropped ?? 0}</TableCell>
                  <TableCell>{result.best_contact_name || "-"}</TableCell>
                  <TableCell>{result.best_contact_email || "-"}</TableCell>
                  <TableCell>{result.error || "-"}</TableCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-emerald-200 bg-white px-3 py-2">
      <span className="block text-base font-semibold">{value}</span>
      <span className="block text-[11px] uppercase text-emerald-700">
        {label}
      </span>
    </div>
  );
}

function ContactsDetail({ contacts }: { contacts: ProspectContactListItem[] }) {
  if (contacts.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No linked prospect_contacts rows for this school yet.
      </p>
    );
  }

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-slate-900">
        Linked Contacts
      </h3>
      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-[1080px] text-left text-xs">
          <thead className="bg-slate-100 uppercase text-slate-600">
            <tr>
              <TableHeader>Rank</TableHeader>
              <TableHeader>Sequence</TableHeader>
              <TableHeader>Name</TableHeader>
              <TableHeader>Title</TableHeader>
              <TableHeader>Email</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader>Reason</TableHeader>
              <TableHeader>Notes</TableHeader>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {contacts.map((contact, index) => (
              <tr key={`${contact.id ?? contact.email ?? index}`}>
                <TableCell>{contact.contact_rank ?? "-"}</TableCell>
                <TableCell>{contact.sequence_pick ? "TRUE" : "FALSE"}</TableCell>
                <TableCell>
                  {[contact.first_name, contact.last_name]
                    .filter(Boolean)
                    .join(" ") || "-"}
                </TableCell>
                <TableCell>{contact.job_title || "-"}</TableCell>
                <TableCell>
                  {contact.email ? (
                    <a
                      className="font-medium text-blue-700 underline-offset-4 hover:underline"
                      href={`mailto:${contact.email}`}
                    >
                      {contact.email}
                    </a>
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell>{contact.email_validation_status || "-"}</TableCell>
                <TableCell>{contact.best_contact_reason || "-"}</TableCell>
                <TableCell>{contact.notes || "-"}</TableCell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TextInput({
  label,
  minLength,
  onChange,
  type = "text",
  uppercase = false,
  value,
}: {
  label: string;
  minLength?: number;
  onChange: (value: string) => void;
  type?: string;
  uppercase?: boolean;
  value: string;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
      {label}
      <input
        className={`h-11 rounded-md border border-slate-300 px-3 text-base text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200 ${
          uppercase ? "uppercase" : ""
        }`}
        minLength={minLength}
        onChange={(event) => onChange(event.target.value)}
        required={Boolean(minLength)}
        type={type}
        value={value}
      />
    </label>
  );
}

function SelectInput({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  value: string;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
      {label}
      <select
        className="h-11 rounded-md border border-slate-300 bg-white px-3 text-base text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value || option.label} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActionButton({
  children,
  className = "border border-slate-300 bg-white text-slate-900 hover:bg-slate-100 disabled:text-slate-400",
  disabled,
  onClick,
  primary = false,
  type = "button",
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  primary?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <div className="flex items-end">
      <button
        className={`h-11 w-full rounded-md px-4 text-sm font-semibold transition disabled:cursor-not-allowed ${
          primary
            ? "bg-slate-950 text-white hover:bg-slate-800 disabled:bg-slate-400"
            : className
        }`}
        disabled={disabled}
        onClick={onClick}
        type={type}
      >
        {children}
      </button>
    </div>
  );
}

function TableHeader({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`px-4 py-3 font-semibold ${className}`} scope="col">
      {children}
    </th>
  );
}

function TableCell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`break-words px-4 py-3 leading-6 text-slate-700 ${className}`}>
      {children}
    </td>
  );
}

function getReadableError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatBestContact(prospect: ProspectListItem) {
  const name = getBestContactName(prospect);
  const title = getBestContactTitle(prospect);

  if (name && title) {
    return `${name}, ${title}`;
  }

  return name || title || "-";
}

function renderBestContact(prospect: ProspectListItem) {
  const name = getBestContactName(prospect);
  const title = getBestContactTitle(prospect);

  if (name && title) {
    return (
      <span>
        <span className="block text-slate-900">{name}</span>
        <span className="block text-xs text-slate-500">
          {title}
        </span>
      </span>
    );
  }

  return name || title ? formatBestContact(prospect) : "-";
}

function formatEmailStatus(prospect: ProspectListItem) {
  return (
    prospect.best_contact_email_validation_status ||
    prospect.contact_email_validation_status ||
    prospect.email_validation_status ||
    "not_checked"
  );
}

function formatEnrollment(prospect: ProspectListItem) {
  return (
    prospect.number_of_students ||
    prospect.hs_enrollment ||
    prospect.total_enrollment ||
    "-"
  );
}

function formatClubsEstimate(prospect: ProspectListItem) {
  return prospect.number_of_clubs || prospect.clubs_count_estimate || "-";
}

function formatFitScore(prospect: ProspectListItem) {
  return prospect.fit_score ?? prospect.data_confidence ?? "-";
}

function formatAiFitReason(prospect: ProspectListItem) {
  return prospect.ai_fit_reason || prospect.personalization_angle || "-";
}

function getBestContactName(prospect: ProspectListItem) {
  return prospect.best_contact_name || prospect.contact_name || "";
}

function getBestContactTitle(prospect: ProspectListItem) {
  return prospect.best_contact_title || prospect.contact_title || "";
}

function getBestContactEmail(prospect: ProspectListItem) {
  return prospect.best_contact_email || prospect.contact_email || "";
}

async function fetchRecentProspects(runId: string, filters: ProspectFilters) {
  const params = buildProspectQueryParams(runId, filters);
  const query = params.toString();
  const response = await fetch(
    `/api/prospects/google-search${query ? `?${query}` : ""}`,
    {
      method: "GET",
      cache: "no-store",
    },
  );
  const payload = (await response.json()) as ProspectsResponse;

  if (!response.ok) {
    throw new Error(payload.error ?? "Unable to load saved prospects.");
  }

  return payload.prospects ?? [];
}

async function fetchRuns() {
  const response = await fetch("/api/prospects/runs", {
    method: "GET",
    cache: "no-store",
  });
  const payload = (await response.json()) as RunsResponse;

  if (!response.ok) {
    throw new Error(payload.error ?? "Unable to load prospect runs.");
  }

  return payload.runs ?? [];
}

function buildProspectQueryParams(runId: string, filters: ProspectFilters) {
  const params = new URLSearchParams();

  if (runId) {
    params.set("runId", runId);
  }

  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      params.set(key, value);
    }
  }

  return params;
}

function idKey(value: string | number) {
  return String(value);
}
