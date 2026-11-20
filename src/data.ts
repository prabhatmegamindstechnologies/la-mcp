// In-memory SAMPLE data. Replace with calls to the LA API in a later phase.
// Data resets every time the server restarts.

export type Status = "open" | "closed";
export type Priority = "low" | "medium" | "high";

export interface ServiceRequest {
  id: string;
  plant: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  createdAt: string;
  createdBy: string;
}

const seed: ServiceRequest[] = [
  { id: "SR-1001", plant: "Plant A - Jamnagar", title: "Pump P-101 high vibration", description: "Vibration on pump P-101 above 7 mm/s since morning shift.", status: "open", priority: "high", createdAt: "2026-11-12T06:30:00Z", createdBy: "sample.user" },
  { id: "SR-1002", plant: "Plant A - Jamnagar", title: "Heat exchanger E-204 fouling", description: "Outlet temperature trending up, suspect fouling.", status: "open", priority: "medium", createdAt: "2026-11-14T09:10:00Z", createdBy: "sample.user" },
  { id: "SR-1003", plant: "Plant A - Jamnagar", title: "Control valve FV-310 sticking", description: "Valve response delayed during load change.", status: "closed", priority: "medium", createdAt: "2026-10-28T11:00:00Z", createdBy: "sample.user" },
  { id: "SR-1004", plant: "Plant B - Dahej", title: "Compressor K-01 trip", description: "Compressor tripped on high discharge temperature.", status: "open", priority: "high", createdAt: "2026-11-18T02:45:00Z", createdBy: "sample.user" },
  { id: "SR-1005", plant: "Plant B - Dahej", title: "Flow meter FT-120 calibration", description: "Scheduled calibration due this month.", status: "open", priority: "low", createdAt: "2026-11-05T08:00:00Z", createdBy: "sample.user" },
  { id: "SR-1006", plant: "Plant B - Dahej", title: "Cooling tower fan noise", description: "Unusual noise from CT fan 2 gearbox.", status: "closed", priority: "low", createdAt: "2026-10-20T13:20:00Z", createdBy: "sample.user" },
  { id: "SR-1007", plant: "Plant C - Hazira", title: "Boiler feed pump seal leak", description: "Small leak at mechanical seal of BFP-2.", status: "open", priority: "medium", createdAt: "2026-11-16T07:15:00Z", createdBy: "sample.user" },
  { id: "SR-1008", plant: "Plant C - Hazira", title: "DCS alarm flood review", description: "Review nuisance alarms on unit 3 DCS.", status: "closed", priority: "low", createdAt: "2026-10-30T10:00:00Z", createdBy: "sample.user" },
];

let requests: ServiceRequest[] = seed.map((r) => ({ ...r }));
let nextId = 1009;

export function searchRequests(opts: { plant?: string; status: Status | "all"; limit: number }): ServiceRequest[] {
  const plant = opts.plant?.trim().toLowerCase();
  return requests
    .filter((r) => opts.status === "all" || r.status === opts.status)
    .filter((r) => !plant || r.plant.toLowerCase().includes(plant))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, opts.limit);
}

export function getRequest(id: string): ServiceRequest | undefined {
  return requests.find((r) => r.id.toLowerCase() === id.trim().toLowerCase());
}

export function createRequest(input: { plant: string; title: string; description: string; priority: Priority }): ServiceRequest {
  const created: ServiceRequest = {
    id: `SR-${nextId++}`,
    plant: input.plant.trim(),
    title: input.title.trim(),
    description: input.description.trim(),
    status: "open",
    priority: input.priority,
    createdAt: new Date().toISOString(),
    createdBy: "mcp.poc", // becomes the signed-in user once OAuth is added
  };
  requests.push(created);
  return created;
}

/** Test helper: restore the original sample data. */
export function resetData(): void {
  requests = seed.map((r) => ({ ...r }));
  nextId = 1009;
}
