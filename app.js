/* =========================================================
   Activity Calendar — app logic
   Data is stored in Supabase (Postgres) so every device shares
   the same live calendar. Every add/edit/delete is written to
   an audit log entry (visible via "Activity History"), and
   changes sync in real time across all open browsers/devices.
   ========================================================= */

const SUPABASE_URL = "https://qyqwphldvbhorxnursov.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5cXdwaGxkdmJob3J4bnVyc292Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMDgyNDIsImV4cCI6MjEwNDc4NDI0Mn0.V5iAi9KCwzm0ZHQMd9JzZXfeqXfuCYH0KIboxhKUpx8";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const ADMIN_PIN = "1234"; // <-- change this to whatever PIN the Admin should use

const MONTH_NAMES = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MAX_RECURRENCES = 200;

let state = {
  role: null, // "admin" | "viewer"
  activities: [],
  viewYear: new Date().getFullYear(),
  viewMonth: new Date().getMonth(), // 0-indexed
  filters: new Set(["all"]), // "all" or any combination of "Pending" | "Cancelled" | "Finished"
  activitySearch: "",
  staffSearch: "",
  selectedDay: null,
  currentView: "calendar", // "calendar" | "list"
  pendingConfirmAction: null,
  viewingActivityId: null, // activity currently open in the staff view/notes panel
  listYearFilter: "all",
  listMonthFilter: "all",
  fitMode: false,
};

/* ---------- persistence (Supabase) ---------- */

// Map a DB row (snake_case) to the app's activity object shape (camelCase).
function fromRow(r) {
  return {
    id: r.id,
    year: r.year, month: r.month, date: r.date,
    endYear: r.end_year, endMonth: r.end_month, endDate: r.end_date,
    name: r.name,
    inCharge: r.in_charge,
    time: r.time || "",
    organizer: r.organizer || "",
    participants: r.participants || "",
    venue: r.venue || "",
    activityStatus: r.activity_status,
    seriesId: r.series_id,
    rescheduledFrom: r.rescheduled_from || null,
    rescheduledTo: r.rescheduled_to || null,
    noteThread: Array.isArray(r.note_thread) ? r.note_thread : [],
  };
}

// Map an app activity object to a DB row for insert/update.
function toRow(a) {
  return {
    id: a.id,
    year: a.year, month: a.month, date: a.date,
    end_year: a.endYear, end_month: a.endMonth, end_date: a.endDate,
    name: a.name,
    in_charge: a.inCharge,
    time: a.time || "",
    organizer: a.organizer || "",
    participants: a.participants || "",
    venue: a.venue || "",
    activity_status: a.activityStatus,
    series_id: a.seriesId || null,
    rescheduled_from: a.rescheduledFrom || null,
    rescheduled_to: a.rescheduledTo || null,
    note_thread: a.noteThread || [],
  };
}

async function loadActivities() {
  try {
    const { data, error } = await supabaseClient.from("activities").select("*");
    if (error) throw error;
    return (data || []).map(fromRow);
  } catch (e) {
    console.error("Failed to load activities from Supabase", e);
    showToast("Couldn't reach the database. Check your connection.");
    return [];
  }
}

async function dbInsertActivities(activities) {
  try {
    const { error } = await supabaseClient.from("activities").insert(activities.map(toRow));
    if (error) throw error;
  } catch (e) {
    console.error("Insert failed", e);
    showToast("Save failed — check your internet connection.");
  }
}

async function dbUpdateActivity(activity) {
  try {
    const { error } = await supabaseClient.from("activities").update(toRow(activity)).eq("id", activity.id);
    if (error) throw error;
  } catch (e) {
    console.error("Update failed", e);
    showToast("Save failed — check your internet connection.");
  }
}

async function dbDeleteActivity(id) {
  try {
    const { error } = await supabaseClient.from("activities").delete().eq("id", id);
    if (error) throw error;
  } catch (e) {
    console.error("Delete failed", e);
    showToast("Delete failed — check your internet connection.");
  }
}

// Older versions stored a single "notes" string. Convert that into the
// first entry of a note thread so nothing typed before is lost.
function migrateActivity(a) {
  if (!Array.isArray(a.noteThread)) {
    a.noteThread = [];
    if (a.notes && a.notes.trim()) {
      a.noteThread.push({
        id: cryptoId(),
        author: "Admin",
        text: a.notes.trim(),
        timestamp: new Date().toISOString(),
      });
    }
  }
  return a;
}

function seedData() {
  const now = new Date();
  return [
    {
      id: cryptoId(),
      year: now.getFullYear(),
      month: now.getMonth(),
      date: Math.min(now.getDate() + 2, 28),
      endYear: now.getFullYear(),
      endMonth: now.getMonth(),
      endDate: Math.min(now.getDate() + 2, 28),
      name: "Morning Exercise Group",
      inCharge: "Juan Dela Cruz",
      noteThread: [],
      activityStatus: "Pending",
      seriesId: null,
    },
    {
      id: cryptoId(),
      year: now.getFullYear(),
      month: now.getMonth(),
      date: Math.min(now.getDate() + 5, 28),
      endYear: now.getFullYear(),
      endMonth: now.getMonth(),
      endDate: Math.min(now.getDate() + 5, 28),
      name: "Bingo Afternoon",
      inCharge: "Maria Santos",
      noteThread: [],
      activityStatus: "Finished",
      seriesId: null,
    },
  ];
}

function cryptoId() {
  return "a_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// Local-only refresh after a mutation already sent to Supabase.
// (Per-record DB writes happen at each call site via dbInsertActivities /
// dbUpdateActivity / dbDeleteActivity — this just refreshes UI helpers.)
function saveActivities() {
  refreshSearchSuggestions();
}

/* ---------- audit trail (Supabase) ---------- */

async function loadAudit() {
  try {
    const { data, error } = await supabaseClient
      .from("audit_log")
      .select("*")
      .order("ts", { ascending: false })
      .limit(500);
    if (error) throw error;
    return (data || []).map((r) => ({
      timestamp: r.ts,
      action: r.action,
      title: r.title,
      detail: r.detail,
    }));
  } catch (e) {
    console.error("Failed to load audit log", e);
    return [];
  }
}

async function writeAudit(action, title, detail) {
  try {
    const { error } = await supabaseClient.from("audit_log").insert({
      action,
      title,
      detail: detail || "",
    });
    if (error) throw error;
  } catch (e) {
    console.error("Failed to write audit entry", e);
  }
}

function diffActivity(before, after) {
  const changes = [];
  if (before.name !== after.name) changes.push(`Name: "${before.name}" → "${after.name}"`);
  if (before.inCharge !== after.inCharge) changes.push(`In-charge: "${before.inCharge}" → "${after.inCharge}"`);
  if (before.activityStatus !== after.activityStatus) changes.push(`Status: ${before.activityStatus} → ${after.activityStatus}`);
  const beforeDate = `${before.year}-${before.month}-${before.date}`;
  const afterDate = `${after.year}-${after.month}-${after.date}`;
  if (beforeDate !== afterDate) changes.push(`Date: ${formatShortDate(before)} → ${formatShortDate(after)}`);
  const beforeEnd = `${before.endYear}-${before.endMonth}-${before.endDate}`;
  const afterEnd = `${after.endYear}-${after.endMonth}-${after.endDate}`;
  if (beforeEnd !== afterEnd) changes.push(`End date: ${formatShortDate({year:before.endYear,month:before.endMonth,date:before.endDate})} → ${formatShortDate({year:after.endYear,month:after.endMonth,date:after.endDate})}`);
  return changes.length ? changes.join("; ") : "No field changes";
}

function formatShortDate(a) {
  return `${MONTH_SHORT[a.month]} ${a.date}, ${a.year}`;
}

function formatTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

/* ---------- note thread ---------- */

function latestNoteSummary(a) {
  if (!a.noteThread || a.noteThread.length === 0) return "";
  const last = a.noteThread[a.noteThread.length - 1];
  const prefix = a.noteThread.length > 1 ? `(${a.noteThread.length} notes) ` : "";
  return `${prefix}${last.author}: ${last.text}`;
}

function getActivity(id) {
  return state.activities.find((a) => a.id === id) || null;
}

function renderNoteThread(container, activity) {
  container.innerHTML = "";
  if (!activity.noteThread || activity.noteThread.length === 0) {
    const p = document.createElement("p");
    p.className = "note-empty";
    p.textContent = "No notes yet.";
    container.appendChild(p);
    return;
  }
  activity.noteThread.forEach((note) => {
    const item = document.createElement("div");
    item.className = "note-item";
    const dt = new Date(note.timestamp);
    const authorClass = note.author === "Admin" ? "author-admin" : "author-staff";
    item.innerHTML = `
      <div class="note-item-top">
        <span class="note-author ${authorClass}">${escapeHtml(note.author)}</span>
        <span class="note-time">${dt.toLocaleString()}</span>
      </div>
      <div class="note-text">${escapeHtml(note.text)}</div>
    `;
    container.appendChild(item);
  });
  container.scrollTop = container.scrollHeight;
}

function addNoteToActivity(activityId, text) {
  const activity = getActivity(activityId);
  if (!activity || !text.trim()) return;
  const author = state.role === "admin" ? "Admin" : "Staff";
  if (!Array.isArray(activity.noteThread)) activity.noteThread = [];
  activity.noteThread.push({
    id: cryptoId(),
    author,
    text: text.trim(),
    timestamp: new Date().toISOString(),
  });
  saveActivities();
  dbUpdateActivity(activity);
  writeAudit("noted", activity.name, `${author} added a note: "${text.trim()}"`);
}

/* ---------- date helpers ---------- */

function addDaysTo(year, month, date, days) {
  const dt = new Date(year, month, date);
  dt.setDate(dt.getDate() + days);
  return { year: dt.getFullYear(), month: dt.getMonth(), date: dt.getDate() };
}

function addMonthsTo(year, month, date, months) {
  const dt = new Date(year, month, date);
  dt.setMonth(dt.getMonth() + months);
  return { year: dt.getFullYear(), month: dt.getMonth(), date: dt.getDate() };
}

function dayCount(y1, m1, d1, y2, m2, d2) {
  const a = new Date(y1, m1, d1).getTime();
  const b = new Date(y2, m2, d2).getTime();
  return Math.round((b - a) / 86400000);
}

function isDayWithin(y, m, d, a) {
  const t = new Date(y, m, d).getTime();
  const start = new Date(a.year, a.month, a.date).getTime();
  const end = new Date(a.endYear, a.endMonth, a.endDate).getTime();
  return t >= start && t <= end;
}

function activityStartTime(a) {
  return new Date(a.year, a.month, a.date).getTime();
}

/* ---------- init ---------- */

document.addEventListener("DOMContentLoaded", async () => {
  state.activities = await loadActivities();
  populateMonthSelect();
  populateListDateFilters();
  refreshSearchSuggestions();
  bindRoleScreen();
  bindApp();
  subscribeToRealtimeChanges();
});

// Keep all open devices/browsers in sync: whenever any device changes the
// activities table, re-fetch and re-render here too.
function subscribeToRealtimeChanges() {
  supabaseClient
    .channel("activities-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "activities" }, async () => {
      state.activities = await loadActivities();
      refreshSearchSuggestions();
      populateListDateFilters();
      if (document.getElementById("app") && !document.getElementById("app").classList.contains("hidden")) {
        renderCurrentView();
      }
    })
    .subscribe();
}

function populateMonthSelect() {
  ["fieldMonth", "fieldEndMonth", "fieldRecurUntilMonth"].forEach((id) => {
    const sel = document.getElementById(id);
    MONTH_NAMES.forEach((m, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = m;
      sel.appendChild(opt);
    });
  });
}

/* ---------- role screen ---------- */

function bindRoleScreen() {
  document.querySelectorAll(".role-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const role = btn.dataset.role;
      if (role === "admin") {
        document.getElementById("adminPinWrap").classList.remove("hidden");
        document.getElementById("adminPin").focus();
      } else {
        enterApp("viewer");
      }
    });
  });

  document.getElementById("pinSubmit").addEventListener("click", submitPin);
  document.getElementById("adminPin").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPin();
  });
}

function submitPin() {
  const val = document.getElementById("adminPin").value.trim();
  if (val === ADMIN_PIN) {
    enterApp("admin");
  } else {
    document.getElementById("pinError").classList.remove("hidden");
  }
}

function enterApp(role) {
  state.role = role;
  document.getElementById("roleScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");

  const badge = document.getElementById("roleBadge");
  badge.textContent = role === "admin" ? "Admin" : "Staff (view only)";

  document.getElementById("addActivityBtn").classList.toggle("hidden", role !== "admin");

  renderCurrentView();
}

/* ---------- app bindings ---------- */

function bindApp() {
  document.getElementById("switchUserBtn").addEventListener("click", () => {
    state.role = null;
    document.getElementById("app").classList.add("hidden");
    document.getElementById("roleScreen").classList.remove("hidden");
    document.getElementById("adminPinWrap").classList.add("hidden");
    document.getElementById("adminPin").value = "";
    document.getElementById("pinError").classList.add("hidden");
  });

  document.getElementById("prevMonth").addEventListener("click", () => shiftMonth(-1));
  document.getElementById("nextMonth").addEventListener("click", () => shiftMonth(1));
  document.getElementById("todayBtn").addEventListener("click", () => {
    const now = new Date();
    state.viewYear = now.getFullYear();
    state.viewMonth = now.getMonth();
    renderCurrentView();
  });

  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.currentView = tab.dataset.view;
      document.querySelectorAll(".view-tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.getElementById("calendarNav").classList.toggle("hidden", state.currentView !== "calendar");
      document.getElementById("calendarView").classList.toggle("hidden", state.currentView !== "calendar");
      document.getElementById("listView").classList.toggle("hidden", state.currentView !== "list");
      document.getElementById("listDateFilters").classList.toggle("hidden", state.currentView !== "list");
      if (state.currentView !== "calendar" && state.fitMode) {
        state.fitMode = false;
        applyFitMode();
      }
      renderCurrentView();
    });
  });

  document.getElementById("listYearFilter").addEventListener("change", (e) => {
    state.listYearFilter = e.target.value;
    renderCurrentView();
  });
  document.getElementById("listMonthFilter").addEventListener("change", (e) => {
    state.listMonthFilter = e.target.value;
    renderCurrentView();
  });

  document.getElementById("activitySearchInput").addEventListener("input", (e) => {
    state.activitySearch = e.target.value.toLowerCase();
    renderCurrentView();
  });
  document.getElementById("staffSearchInput").addEventListener("input", (e) => {
    state.staffSearch = e.target.value.toLowerCase();
    renderCurrentView();
  });

  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const val = chip.dataset.filter;
      if (val === "all") {
        state.filters = new Set(["all"]);
      } else {
        state.filters.delete("all");
        if (state.filters.has(val)) {
          state.filters.delete(val);
        } else {
          state.filters.add(val);
        }
        if (state.filters.size === 0) state.filters = new Set(["all"]);
      }
      syncFilterChips();
      renderCurrentView();
    });
  });

  document.getElementById("resetFilters").addEventListener("click", () => {
    state.filters = new Set(["all"]);
    state.activitySearch = "";
    state.staffSearch = "";
    state.listYearFilter = "all";
    state.listMonthFilter = "all";
    document.getElementById("activitySearchInput").value = "";
    document.getElementById("staffSearchInput").value = "";
    document.getElementById("listYearFilter").value = "all";
    document.getElementById("listMonthFilter").value = "all";
    syncFilterChips();
    renderCurrentView();
  });

  document.getElementById("addActivityBtn").addEventListener("click", () => openEditModal(null, null));
  document.getElementById("addFromDay").addEventListener("click", () => {
    closeModal("dayModal");
    openEditModal(null, state.selectedDay);
  });

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  document.getElementById("activityForm").addEventListener("submit", handleFormSubmit);
  document.getElementById("deleteActivityBtn").addEventListener("click", handleDeleteClick);
  document.getElementById("rescheduleActivityBtn").addEventListener("click", handleRescheduleClick);

  document.querySelectorAll("#statusToggle .status-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#statusToggle .status-toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  document.querySelectorAll(".recur-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".recur-mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.mode;
      document.getElementById("recurUntilWrap").classList.toggle("hidden", mode !== "date");
      document.getElementById("recurCountWrap").classList.toggle("hidden", mode !== "count");
      updateRecurPreview();
    });
  });

  document.getElementById("multiDayCheck").addEventListener("change", (e) => {
    document.getElementById("multiDayFields").classList.toggle("hidden", !e.target.checked);
    if (e.target.checked) {
      // default end date to start date
      document.getElementById("fieldEndYear").value = document.getElementById("fieldYear").value;
      document.getElementById("fieldEndMonth").value = document.getElementById("fieldMonth").value;
      document.getElementById("fieldEndDate").value = document.getElementById("fieldDate").value;
    }
  });

  document.getElementById("recurringCheck").addEventListener("change", (e) => {
    document.getElementById("recurringFields").classList.toggle("hidden", !e.target.checked);
    if (e.target.checked) updateRecurPreview();
  });

  ["fieldFrequency", "fieldRecurUntilYear", "fieldRecurUntilMonth", "fieldRecurUntilDate", "fieldRecurCount"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateRecurPreview);
    document.getElementById(id).addEventListener("change", updateRecurPreview);
  });
  ["fieldYear", "fieldMonth", "fieldDate"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateRecurPreview);
    document.getElementById(id).addEventListener("change", updateRecurPreview);
  });

  document.querySelectorAll("#viewStatusToggle .status-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const activity = getActivity(state.viewingActivityId);
      if (!activity || activity.activityStatus === btn.dataset.status) return;
      const oldStatus = activity.activityStatus;
      activity.activityStatus = btn.dataset.status;
      saveActivities();
      dbUpdateActivity(activity);
      writeAudit("edited", activity.name, `Status: ${oldStatus} → ${activity.activityStatus} (by ${state.role === "admin" ? "Admin" : "Staff"})`);
      document.querySelectorAll("#viewStatusToggle .status-toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
      showToast("Status updated and saved.");
      renderCurrentView();
    });
  });

  document.getElementById("viewNoteSubmit").addEventListener("click", () => {
    const input = document.getElementById("viewNoteInput");
    if (!input.value.trim()) return;
    addNoteToActivity(state.viewingActivityId, input.value);
    input.value = "";
    const activity = getActivity(state.viewingActivityId);
    renderNoteThread(document.getElementById("viewNoteThread"), activity);
    showToast("Note added and saved.");
    renderCurrentView();
  });

  document.getElementById("editNoteSubmit").addEventListener("click", () => {
    const input = document.getElementById("editNoteInput");
    const id = document.getElementById("activityId").value;
    if (!input.value.trim() || !id) return;
    addNoteToActivity(id, input.value);
    input.value = "";
    const activity = getActivity(id);
    renderNoteThread(document.getElementById("editNoteThread"), activity);
    showToast("Note added and saved.");
    renderCurrentView();
  });

  document.getElementById("historyBtn").addEventListener("click", openHistoryModal);

  document.getElementById("printMenuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("printMenu").classList.toggle("hidden");
  });
  document.addEventListener("click", () => document.getElementById("printMenu").classList.add("hidden"));
  document.getElementById("printListItem").addEventListener("click", () => {
    document.getElementById("printMenu").classList.add("hidden");
    handlePrintList();
  });
  document.getElementById("printCalendarItem").addEventListener("click", () => {
    document.getElementById("printMenu").classList.add("hidden");
    handlePrintCalendar();
  });

  document.getElementById("backupBtn").addEventListener("click", downloadBackup);
  document.getElementById("fitScreenBtn").addEventListener("click", toggleFitScreen);
  window.addEventListener("resize", () => { if (state.fitMode) applyFitMode(); });

  document.getElementById("confirmCancelBtn").addEventListener("click", () => {
    state.pendingConfirmAction = null;
    closeModal("confirmModal");
  });
  document.getElementById("confirmOkBtn").addEventListener("click", () => {
    const action = state.pendingConfirmAction;
    state.pendingConfirmAction = null;
    closeModal("confirmModal");
    if (typeof action === "function") action();
  });
}

function shiftMonth(delta) {
  state.viewMonth += delta;
  if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
  if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
  renderCurrentView();
}

function renderCurrentView() {
  if (state.currentView === "list") {
    renderListView();
  } else {
    renderCalendar();
  }
}

/* ---------- shared filtering ---------- */

function syncFilterChips() {
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.classList.toggle("active", state.filters.has(chip.dataset.filter));
  });
}

function getFilteredActivities() {
  return state.activities.filter((a) => {
    if (!state.filters.has("all") && !state.filters.has(a.activityStatus)) return false;
    if (state.activitySearch && !a.name.toLowerCase().includes(state.activitySearch)) return false;
    if (state.staffSearch && !a.inCharge.toLowerCase().includes(state.staffSearch)) return false;
    if (state.currentView === "list") {
      if (state.listYearFilter !== "all" || state.listMonthFilter !== "all") {
        if (!matchesYearMonthFilter(a, state.listYearFilter, state.listMonthFilter)) return false;
      }
    }
    return true;
  });
}

// Checks whether an activity (which may span multiple days) overlaps the
// chosen year and/or month filter. "all" for either means "any".
function matchesYearMonthFilter(a, yearFilter, monthFilter) {
  const start = new Date(a.year, a.month, a.date).getTime();
  const end = new Date(a.endYear, a.endMonth, a.endDate).getTime();

  if (yearFilter !== "all" && monthFilter !== "all") {
    const y = parseInt(yearFilter, 10), m = parseInt(monthFilter, 10);
    const rangeStart = new Date(y, m, 1).getTime();
    const rangeEnd = new Date(y, m + 1, 0).getTime();
    return start <= rangeEnd && end >= rangeStart;
  }
  if (yearFilter !== "all") {
    const y = parseInt(yearFilter, 10);
    const rangeStart = new Date(y, 0, 1).getTime();
    const rangeEnd = new Date(y, 11, 31).getTime();
    return start <= rangeEnd && end >= rangeStart;
  }
  if (monthFilter !== "all") {
    const m = parseInt(monthFilter, 10);
    // Any year — check if activity touches this month in any year it spans.
    const startYear = a.year, endYear = a.endYear;
    for (let y = startYear; y <= endYear; y++) {
      const rangeStart = new Date(y, m, 1).getTime();
      const rangeEnd = new Date(y, m + 1, 0).getTime();
      if (start <= rangeEnd && end >= rangeStart) return true;
    }
    return false;
  }
  return true;
}

// Builds the Year dropdown for the List View filter from whatever years
// actually appear in the data, plus a small range around today.
function populateListDateFilters() {
  const yearSel = document.getElementById("listYearFilter");
  const monthSel = document.getElementById("listMonthFilter");
  if (!yearSel || !monthSel) return;

  const years = new Set();
  const now = new Date();
  for (let y = now.getFullYear() - 2; y <= now.getFullYear() + 3; y++) years.add(y);
  state.activities.forEach((a) => { years.add(a.year); years.add(a.endYear); });

  const prevYearVal = yearSel.value || "all";
  yearSel.innerHTML = `<option value="all">All years</option>` +
    Array.from(years).sort((a, b) => a - b).map((y) => `<option value="${y}">${y}</option>`).join("");
  yearSel.value = Array.from(years).map(String).includes(prevYearVal) ? prevYearVal : "all";

  if (!monthSel.dataset.built) {
    monthSel.innerHTML = `<option value="all">All months</option>` +
      MONTH_NAMES.map((m, i) => `<option value="${i}">${m}</option>`).join("");
    monthSel.dataset.built = "1";
  }
}

// Populates all predictive <datalist> suggestion lists from whatever
// activity/staff/organizer/venue/participant values already exist.
function refreshSearchSuggestions() {
  const names = new Set(), staff = new Set(), organizers = new Set(), venues = new Set(), participants = new Set();
  state.activities.forEach((a) => {
    if (a.name) names.add(a.name);
    if (a.inCharge) staff.add(a.inCharge);
    if (a.organizer) organizers.add(a.organizer);
    if (a.venue) venues.add(a.venue);
    if (a.participants) participants.add(a.participants);
  });
  const fill = (id, set) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = Array.from(set).sort().map((n) => `<option value="${escapeHtml(n)}">`).join("");
  };
  fill("activityNameOptions", names);
  fill("staffNameOptions", staff);
  fill("inChargeOptions", staff);
  fill("organizerOptions", organizers);
  fill("venueOptions", venues);
  fill("participantsOptions", participants);
}

/* ---------- calendar rendering ---------- */

function renderCalendar() {
  document.getElementById("monthLabel").textContent =
    `${MONTH_NAMES[state.viewMonth]} ${state.viewYear}`;

  const grid = document.getElementById("calendarGrid");
  grid.innerHTML = "";

  DAY_NAMES.forEach((d) => {
    const el = document.createElement("div");
    el.className = "day-header";
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDow = new Date(state.viewYear, state.viewMonth, 1).getDay();
  const daysInMonth = new Date(state.viewYear, state.viewMonth + 1, 0).getDate();
  const filtered = getFilteredActivities();

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === state.viewYear && today.getMonth() === state.viewMonth;

  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement("div");
    el.className = "day-cell empty";
    grid.appendChild(el);
  }

  let anyVisible = false;

  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement("div");
    cell.className = "day-cell";
    if (isCurrentMonth && today.getDate() === day) cell.classList.add("today");

    const num = document.createElement("div");
    num.className = "day-number";
    num.textContent = day;
    cell.appendChild(num);

    const dayActivities = filtered.filter((a) => isDayWithin(state.viewYear, state.viewMonth, day, a));

    if (dayActivities.length > 0) anyVisible = true;

    const list = document.createElement("div");
    list.className = "day-activities";
    dayActivities.slice(0, 3).forEach((a) => {
      const pill = document.createElement("div");
      const isMultiDay = a.endYear !== a.year || a.endMonth !== a.month || a.endDate !== a.date;
      pill.className = "day-pill " + statusClass(a.activityStatus) + (isMultiDay ? " multiday" : "");

      let icons = "";
      if (a.seriesId) icons += `<span class="pill-icon" title="Part of a repeating series">↻</span>`;
      if (isMultiDay) {
        const total = dayCount(a.year, a.month, a.date, a.endYear, a.endMonth, a.endDate) + 1;
        const current = dayCount(a.year, a.month, a.date, state.viewYear, state.viewMonth, day) + 1;
        icons += `<span class="pill-icon" title="Multi-day activity">(Day ${current}/${total})</span>`;
      }

      pill.innerHTML = `
        <div class="day-pill-name">${icons}<span>${escapeHtml(a.name)}</span></div>
        <div class="day-pill-incharge">${escapeHtml(a.inCharge)}</div>
      `;
      list.appendChild(pill);
    });
    if (dayActivities.length > 3) {
      const more = document.createElement("div");
      more.className = "day-more";
      more.textContent = `+${dayActivities.length - 3} more`;
      list.appendChild(more);
    }
    cell.appendChild(list);

    cell.addEventListener("click", () => openDayModal(day));
    grid.appendChild(cell);
  }

  const hasSearchOrFilter = state.activitySearch || state.staffSearch || !state.filters.has("all");
  document.getElementById("emptyState").classList.toggle("hidden", !(hasSearchOrFilter && !anyVisible));

  if (state.fitMode) applyFitMode();
}

/* ---------- list view rendering ---------- */

function renderListView() {
  const filtered = getFilteredActivities().slice().sort((a, b) => activityStartTime(a) - activityStartTime(b));
  const tbody = document.getElementById("activityTableBody");
  tbody.innerHTML = "";

  filtered.forEach((a) => {
    const tr = document.createElement("tr");
    const isMultiDay = a.endYear !== a.year || a.endMonth !== a.month || a.endDate !== a.date;
    const dateLabel = (isMultiDay
      ? `${MONTH_SHORT[a.month]} ${a.date} – ${MONTH_SHORT[a.endMonth]} ${a.endDate}, ${a.endYear}`
      : `${MONTH_SHORT[a.month]} ${a.date}, ${a.year}`) + (a.time ? ` · ${formatTime(a.time)}` : "");

    tr.classList.add("clickable");
    if (a.activityStatus === "Rescheduled") tr.classList.add("row-rescheduled");
    tr.addEventListener("click", () => openActivity(a.id));

    const seriesIcon = a.seriesId ? `<span title="Part of a repeating series">↻ </span>` : "";
    let notesCell = escapeHtml(latestNoteSummary(a));
    if (a.activityStatus === "Rescheduled" && a.rescheduledTo) {
      const target = getActivity(a.rescheduledTo);
      if (target) notesCell = `Moved to ${escapeHtml(formatShortDate(target))}${target.time ? " · " + escapeHtml(formatTime(target.time)) : ""}`;
    }

    tr.innerHTML = `
      <td class="table-date">${dateLabel}</td>
      <td class="table-name">${seriesIcon}${escapeHtml(a.name)}</td>
      <td>${escapeHtml(a.venue || "")}</td>
      <td>${escapeHtml(a.organizer || "")}</td>
      <td>${escapeHtml(a.participants || "")}</td>
      <td>${escapeHtml(a.inCharge)}</td>
      <td><span class="badge ${statusClass(a.activityStatus)}">${a.activityStatus}</span></td>
      <td class="table-notes">${notesCell}</td>
    `;
    tbody.appendChild(tr);
  });

  const hasSearchOrFilter = state.activitySearch || state.staffSearch || !state.filters.has("all");
  document.getElementById("listEmptyState").classList.toggle("hidden", filtered.length > 0);
  document.getElementById("activityTableBody").parentElement.parentElement.classList.toggle("hidden", filtered.length === 0);
}

/* ---------- day modal ---------- */

function openDayModal(day) {
  state.selectedDay = day;
  const title = `${MONTH_NAMES[state.viewMonth]} ${day}, ${state.viewYear}`;
  document.getElementById("dayModalTitle").textContent = title;

  const dayActivities = getFilteredActivities().filter((a) => isDayWithin(state.viewYear, state.viewMonth, day, a));

  const list = document.getElementById("dayModalList");
  list.innerHTML = "";

  if (dayActivities.length === 0) {
    const p = document.createElement("p");
    p.style.color = "var(--ink-soft)";
    p.textContent = "No activities scheduled for this day yet.";
    list.appendChild(p);
  }

  dayActivities.forEach((a) => {
    const item = document.createElement("div");
    item.className = "day-item";

    const main = document.createElement("div");
    main.className = "day-item-main";
    const metaBits = [`In charge: ${a.inCharge}`];
    if (a.time) metaBits.unshift(formatTime(a.time));
    if (a.venue) metaBits.push(`Venue: ${a.venue}`);
    if (a.organizer) metaBits.push(`Organizer: ${a.organizer}`);
    main.innerHTML = `
      <div class="day-item-name">${a.seriesId ? "↻ " : ""}${escapeHtml(a.name)}</div>
      <div class="day-item-meta">${escapeHtml(metaBits.join(" · "))}</div>
      ${a.noteThread && a.noteThread.length ? `<div class="day-item-notes">${escapeHtml(latestNoteSummary(a))}</div>` : ""}
    `;

    const badge = document.createElement("span");
    badge.className = "badge " + statusClass(a.activityStatus);
    badge.textContent = a.activityStatus;

    item.appendChild(main);
    item.appendChild(badge);

    item.style.cursor = "pointer";
    item.addEventListener("click", () => {
      closeModal("dayModal");
      openActivity(a.id);
    });

    list.appendChild(item);
  });

  document.getElementById("addFromDay").classList.toggle("hidden", state.role !== "admin");
  openModal("dayModal");
}

/* ---------- routing: admin edits structurally, staff views/annotates ---------- */

function openActivity(activityId) {
  if (state.role === "admin") {
    openEditModal(activityId, null);
  } else {
    openViewModal(activityId);
  }
}

/* ---------- staff view / notes / status panel ---------- */

function openViewModal(activityId) {
  const activity = getActivity(activityId);
  if (!activity) return;

  state.viewingActivityId = activityId;

  document.getElementById("viewModalTitle").textContent = activity.name;
  document.getElementById("viewName").textContent = activity.name;

  const isMultiDay = activity.endYear !== activity.year || activity.endMonth !== activity.month || activity.endDate !== activity.date;
  const dateLabel = isMultiDay
    ? `${formatShortDate(activity)} – ${formatShortDate({ year: activity.endYear, month: activity.endMonth, date: activity.endDate })}`
    : formatShortDate(activity);
  const metaBits = [dateLabel];
  if (activity.time) metaBits.push(formatTime(activity.time));
  metaBits.push(`In charge: ${activity.inCharge}`);
  if (activity.venue) metaBits.push(`Venue: ${activity.venue}`);
  if (activity.organizer) metaBits.push(`Organizer: ${activity.organizer}`);
  if (activity.participants) metaBits.push(`Participants: ${activity.participants}`);
  document.getElementById("viewMeta").textContent = metaBits.join(" · ");

  document.querySelectorAll("#viewStatusToggle .status-toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.status === activity.activityStatus);
  });

  renderNoteThread(document.getElementById("viewNoteThread"), activity);
  document.getElementById("viewNoteInput").value = "";

  openModal("viewModal");
}

/* ---------- edit modal ---------- */

function openEditModal(activityId, presetDay) {
  if (state.role !== "admin") return;

  const form = document.getElementById("activityForm");
  form.reset();

  const activity = activityId ? state.activities.find((a) => a.id === activityId) : null;

  document.getElementById("editModalTitle").textContent = activity ? "Edit Activity" : "Add Activity";
  document.getElementById("activityId").value = activity ? activity.id : "";
  document.getElementById("deleteActivityBtn").classList.toggle("hidden", !activity);
  document.getElementById("rescheduleActivityBtn").classList.toggle("hidden", !activity || activity.activityStatus === "Rescheduled");

  document.getElementById("fieldYear").value = activity ? activity.year : state.viewYear;
  document.getElementById("fieldMonth").value = activity ? activity.month : state.viewMonth;
  document.getElementById("fieldDate").value = activity ? activity.date : (presetDay || 1);
  document.getElementById("fieldTime").value = activity ? (activity.time || "") : "";
  document.getElementById("fieldName").value = activity ? activity.name : "";
  document.getElementById("fieldInCharge").value = activity ? activity.inCharge : "";
  document.getElementById("fieldOrganizer").value = activity ? (activity.organizer || "") : "";
  document.getElementById("fieldParticipants").value = activity ? (activity.participants || "") : "";
  document.getElementById("fieldVenue").value = activity ? (activity.venue || "") : "";

  const activityStatus = activity ? activity.activityStatus : "Pending";
  document.querySelectorAll("#statusToggle .status-toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.status === activityStatus);
  });

  // Multi-day fields
  const isMultiDay = activity && (activity.endYear !== activity.year || activity.endMonth !== activity.month || activity.endDate !== activity.date);
  document.getElementById("multiDayCheck").checked = !!isMultiDay;
  document.getElementById("multiDayFields").classList.toggle("hidden", !isMultiDay);
  document.getElementById("fieldEndYear").value = activity ? activity.endYear : (presetDay ? state.viewYear : state.viewYear);
  document.getElementById("fieldEndMonth").value = activity ? activity.endMonth : state.viewMonth;
  document.getElementById("fieldEndDate").value = activity ? activity.endDate : (presetDay || 1);

  // Recurring: only offered for brand-new activities, never when editing an existing one
  // (editing affects only this single occurrence, keeping the interaction simple).
  document.getElementById("recurringCheck").checked = false;
  document.getElementById("recurringFields").classList.add("hidden");
  document.getElementById("recurringCheckRow").classList.toggle("hidden", !!activity);
  document.getElementById("recurringLockedNote").classList.toggle("hidden", !activity);
  document.getElementById("fieldFrequency").value = "weekly";
  document.querySelectorAll(".recur-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === "date"));
  document.getElementById("recurUntilWrap").classList.remove("hidden");
  document.getElementById("recurCountWrap").classList.add("hidden");
  document.getElementById("fieldRecurCount").value = 4;
  document.getElementById("fieldRecurUntilYear").value = state.viewYear;
  document.getElementById("fieldRecurUntilMonth").value = state.viewMonth;
  document.getElementById("fieldRecurUntilDate").value = presetDay || 1;
  document.getElementById("recurPreview").textContent = "";

  // Notes can only be threaded onto an activity that already exists.
  document.getElementById("editNoteSection").classList.toggle("hidden", !activity);
  if (activity) {
    renderNoteThread(document.getElementById("editNoteThread"), activity);
  }
  document.getElementById("editNoteInput").value = "";

  openModal("editModal");
}

function readForm() {
  return {
    year: parseInt(document.getElementById("fieldYear").value, 10),
    month: parseInt(document.getElementById("fieldMonth").value, 10),
    date: parseInt(document.getElementById("fieldDate").value, 10),
    time: document.getElementById("fieldTime").value,
    name: document.getElementById("fieldName").value.trim(),
    inCharge: document.getElementById("fieldInCharge").value.trim(),
    organizer: document.getElementById("fieldOrganizer").value.trim(),
    participants: document.getElementById("fieldParticipants").value.trim(),
    venue: document.getElementById("fieldVenue").value.trim(),
    activityStatus: document.querySelector("#statusToggle .status-toggle-btn.active").dataset.status,
  };
}

function updateRecurPreview() {
  const preview = document.getElementById("recurPreview");
  if (document.getElementById("recurringFields").classList.contains("hidden")) {
    preview.textContent = "";
    return;
  }
  try {
    const base = readForm();
    const freq = document.getElementById("fieldFrequency").value;
    const mode = document.querySelector(".recur-mode-btn.active").dataset.mode;
    let occurrences;
    if (mode === "count") {
      const count = Math.min(MAX_RECURRENCES, Math.max(1, parseInt(document.getElementById("fieldRecurCount").value, 10) || 1));
      occurrences = computeRecurrenceDates(base.year, base.month, base.date, freq, "count", count, null);
    } else {
      const uy = parseInt(document.getElementById("fieldRecurUntilYear").value, 10);
      const um = parseInt(document.getElementById("fieldRecurUntilMonth").value, 10);
      const ud = parseInt(document.getElementById("fieldRecurUntilDate").value, 10);
      if (!uy || isNaN(um) || !ud) { preview.textContent = ""; return; }
      occurrences = computeRecurrenceDates(base.year, base.month, base.date, freq, "date", null, { year: uy, month: um, date: ud });
    }
    preview.textContent = `This will create ${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"}, from ${formatShortDate({year:base.year,month:base.month,date:base.date})} to ${formatShortDate(occurrences[occurrences.length - 1])}.`;
  } catch (e) {
    preview.textContent = "";
  }
}

function computeRecurrenceDates(year, month, date, freq, endMode, count, untilDate) {
  const dates = [];
  let cursor = { year, month, date };
  const untilTime = untilDate ? new Date(untilDate.year, untilDate.month, untilDate.date).getTime() : null;

  for (let i = 0; i < MAX_RECURRENCES; i++) {
    if (endMode === "date" && new Date(cursor.year, cursor.month, cursor.date).getTime() > untilTime) break;
    dates.push({ ...cursor });
    if (endMode === "count" && dates.length >= count) break;

    if (freq === "daily") cursor = addDaysTo(cursor.year, cursor.month, cursor.date, 1);
    else if (freq === "weekly") cursor = addDaysTo(cursor.year, cursor.month, cursor.date, 7);
    else cursor = addMonthsTo(cursor.year, cursor.month, cursor.date, 1);
  }
  return dates;
}

function handleFormSubmit(e) {
  e.preventDefault();
  if (state.role !== "admin") return;

  const id = document.getElementById("activityId").value;
  const payload = readForm();

  if (!payload.name || !payload.inCharge) return;

  const isMultiDay = document.getElementById("multiDayCheck").checked;
  let endYear = payload.year, endMonth = payload.month, endDate = payload.date;
  if (isMultiDay) {
    endYear = parseInt(document.getElementById("fieldEndYear").value, 10);
    endMonth = parseInt(document.getElementById("fieldEndMonth").value, 10);
    endDate = parseInt(document.getElementById("fieldEndDate").value, 10);
    if (new Date(endYear, endMonth, endDate).getTime() < new Date(payload.year, payload.month, payload.date).getTime()) {
      showToast("End date can't be before the start date.");
      return;
    }
  }
  payload.endYear = endYear;
  payload.endMonth = endMonth;
  payload.endDate = endDate;

  if (id) {
    // Editing a single existing activity/occurrence.
    const idx = state.activities.findIndex((a) => a.id === id);
    if (idx > -1) {
      const before = state.activities[idx];
      const after = { ...before, ...payload };
      const detail = diffActivity(before, after);
      state.activities[idx] = after;
      saveActivities();
      dbUpdateActivity(after);
      writeAudit("edited", payload.name, detail);
      showToast("Activity updated and saved.");
    }
  } else {
    const isRecurring = document.getElementById("recurringCheck").checked;
    const spanDays = isMultiDay ? dayCount(payload.year, payload.month, payload.date, endYear, endMonth, endDate) : 0;

    if (isRecurring) {
      const freq = document.getElementById("fieldFrequency").value;
      const mode = document.querySelector(".recur-mode-btn.active").dataset.mode;
      let occurrences;
      if (mode === "count") {
        const count = Math.min(MAX_RECURRENCES, Math.max(1, parseInt(document.getElementById("fieldRecurCount").value, 10) || 1));
        occurrences = computeRecurrenceDates(payload.year, payload.month, payload.date, freq, "count", count, null);
      } else {
        const uy = parseInt(document.getElementById("fieldRecurUntilYear").value, 10);
        const um = parseInt(document.getElementById("fieldRecurUntilMonth").value, 10);
        const ud = parseInt(document.getElementById("fieldRecurUntilDate").value, 10);
        if (!uy || isNaN(um) || !ud || new Date(uy, um, ud).getTime() < new Date(payload.year, payload.month, payload.date).getTime()) {
          showToast("Please choose a valid 'until' date after the start date.");
          return;
        }
        occurrences = computeRecurrenceDates(payload.year, payload.month, payload.date, freq, "date", null, { year: uy, month: um, date: ud });
      }

      const seriesId = cryptoId();
      const newOnes = [];
      occurrences.forEach((occ) => {
        const occEnd = addDaysTo(occ.year, occ.month, occ.date, spanDays);
        const newActivity = {
          id: cryptoId(),
          year: occ.year, month: occ.month, date: occ.date,
          endYear: occEnd.year, endMonth: occEnd.month, endDate: occEnd.date,
          name: payload.name, inCharge: payload.inCharge, time: payload.time,
          organizer: payload.organizer, participants: payload.participants, venue: payload.venue,
          noteThread: [],
          activityStatus: payload.activityStatus,
          seriesId,
        };
        state.activities.push(newActivity);
        newOnes.push(newActivity);
      });
      saveActivities();
      dbInsertActivities(newOnes);
      writeAudit("added", payload.name, `Repeating series (${freq}), ${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"} created`);
      showToast(`Added ${occurrences.length} occurrences and saved.`);
    } else {
      const newActivity = { id: cryptoId(), ...payload, seriesId: null, noteThread: [] };
      state.activities.push(newActivity);
      saveActivities();
      dbInsertActivities([newActivity]);
      writeAudit("added", payload.name, isMultiDay ? `Spans ${formatShortDate(payload)} to ${formatShortDate({year:endYear,month:endMonth,date:endDate})}` : `Scheduled for ${formatShortDate(payload)}`);
      showToast("Activity added and saved.");
    }
  }

  closeModal("editModal");
  renderCurrentView();
}

function handleDeleteClick() {
  if (state.role !== "admin") return;
  const id = document.getElementById("activityId").value;
  const activity = state.activities.find((a) => a.id === id);
  if (!activity) return;

  showConfirm(
    "Delete Activity",
    `Delete "${activity.name}" on ${formatShortDate(activity)}? This cannot be undone.`,
    () => {
      state.activities = state.activities.filter((a) => a.id !== id);
      saveActivities();
      dbDeleteActivity(id);
      writeAudit("deleted", activity.name, `Was scheduled for ${formatShortDate(activity)}, status: ${activity.activityStatus}`);
      showToast("Activity deleted and saved.");
      closeModal("editModal");
      renderCurrentView();
    }
  );
}

/* ---------- reschedule (keeps the old occurrence as grey history) ---------- */

function handleRescheduleClick() {
  if (state.role !== "admin") return;
  const id = document.getElementById("activityId").value;
  const before = id ? state.activities.find((a) => a.id === id) : null;
  if (!before) return;

  const payload = readForm();
  if (!payload.name || !payload.inCharge) {
    showToast("Please fill in the required fields first.");
    return;
  }

  const isMultiDay = document.getElementById("multiDayCheck").checked;
  let endYear = payload.year, endMonth = payload.month, endDate = payload.date;
  if (isMultiDay) {
    endYear = parseInt(document.getElementById("fieldEndYear").value, 10);
    endMonth = parseInt(document.getElementById("fieldEndMonth").value, 10);
    endDate = parseInt(document.getElementById("fieldEndDate").value, 10);
    if (new Date(endYear, endMonth, endDate).getTime() < new Date(payload.year, payload.month, payload.date).getTime()) {
      showToast("End date can't be before the start date.");
      return;
    }
  }
  payload.endYear = endYear;
  payload.endMonth = endMonth;
  payload.endDate = endDate;

  const sameWhen = before.year === payload.year && before.month === payload.month &&
    before.date === payload.date && (before.time || "") === (payload.time || "");
  if (sameWhen) {
    showToast("Change the date or time above first, then click Reschedule.");
    return;
  }

  showConfirm(
    "Reschedule Activity",
    `"${before.name}" on ${formatShortDate(before)} will be kept as a greyed-out history record marked "Rescheduled," and a new occurrence will be created on ${formatShortDate(payload)}. Continue?`,
    () => {
      const newActivity = {
        id: cryptoId(),
        ...payload,
        seriesId: before.seriesId || null,
        noteThread: [],
        rescheduledFrom: before.id,
        rescheduledTo: null,
      };
      state.activities.push(newActivity);

      before.activityStatus = "Rescheduled";
      before.rescheduledTo = newActivity.id;

      saveActivities();
      dbInsertActivities([newActivity]);
      dbUpdateActivity(before);
      writeAudit("edited", before.name, `Rescheduled: ${formatShortDate(before)} → ${formatShortDate(payload)}`);
      showToast("Rescheduled. The original is kept as history.");
      closeModal("editModal");
      renderCurrentView();
    }
  );
}



function showConfirm(title, message, onConfirm) {
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMessage").textContent = message;
  state.pendingConfirmAction = onConfirm;
  openModal("confirmModal");
}

/* ---------- history modal ---------- */

async function openHistoryModal() {
  const list = document.getElementById("historyList");
  list.innerHTML = `<p style="color:var(--ink-soft);">Loading...</p>`;
  openModal("historyModal");
  const log = await loadAudit();
  list.innerHTML = "";
  list.innerHTML = "";

  if (log.length === 0) {
    const p = document.createElement("p");
    p.style.color = "var(--ink-soft)";
    p.textContent = "No activity yet. Every add, edit, or deletion will show up here.";
    list.appendChild(p);
  }

  log.forEach((entry) => {
    const item = document.createElement("div");
    item.className = `history-item action-${entry.action}`;
    const dt = new Date(entry.timestamp);
    const actionLabel = entry.action === "added" ? "Added" : entry.action === "edited" ? "Edited" : entry.action === "noted" ? "Note" : "Deleted";
    item.innerHTML = `
      <div class="history-item-top">
        <span class="history-item-title">${actionLabel}: ${escapeHtml(entry.title)}</span>
        <span class="history-item-time">${dt.toLocaleString()}</span>
      </div>
      <div class="history-item-detail">${escapeHtml(entry.detail)}</div>
    `;
    list.appendChild(item);
  });
}

/* ---------- print ---------- */

function handlePrintList() {
  const printArea = document.getElementById("printArea");
  const filtered = getFilteredActivities().slice().sort((a, b) => activityStartTime(a) - activityStartTime(b));

  let scoped, subtitle;
  if (state.currentView === "calendar") {
    scoped = filtered.filter((a) => isSameMonthOverlap(a, state.viewYear, state.viewMonth));
    subtitle = `${MONTH_NAMES[state.viewMonth]} ${state.viewYear}`;
  } else {
    scoped = filtered;
    subtitle = "All scheduled activities";
  }

  const filterNote = state.filters.has("all") ? "All statuses" : Array.from(state.filters).join(", ");
  const searchBits = [];
  if (state.activitySearch) searchBits.push(`activity contains "${state.activitySearch}"`);
  if (state.staffSearch) searchBits.push(`staff contains "${state.staffSearch}"`);
  if (state.currentView === "list") {
    if (state.listYearFilter !== "all") searchBits.push(`year: ${state.listYearFilter}`);
    if (state.listMonthFilter !== "all") searchBits.push(`month: ${MONTH_NAMES[parseInt(state.listMonthFilter, 10)]}`);
  }
  const searchNote = searchBits.length ? ` · Filters: ${searchBits.join(", ")}` : "";

  // Full detail card per activity, so nothing is left off the printout.
  let cards = scoped.map((a) => {
    const isMultiDay = a.endYear !== a.year || a.endMonth !== a.month || a.endDate !== a.date;
    const dateLabel = isMultiDay
      ? `${MONTH_SHORT[a.month]} ${a.date} – ${MONTH_SHORT[a.endMonth]} ${a.endDate}, ${a.endYear}`
      : `${MONTH_SHORT[a.month]} ${a.date}, ${a.year}`;

    const notesHtml = (a.noteThread && a.noteThread.length)
      ? `<ul class="print-notes">${a.noteThread.map((n) => `<li><strong>${escapeHtml(n.author)}</strong> (${new Date(n.timestamp).toLocaleString()}): ${escapeHtml(n.text)}</li>`).join("")}</ul>`
      : `<p class="print-notes-empty">No notes.</p>`;

    return `
      <div class="print-card">
        <div class="print-card-header">
          <span class="print-card-name">${a.seriesId ? "↻ " : ""}${escapeHtml(a.name)}</span>
          <span class="print-card-status">${a.activityStatus}</span>
        </div>
        <table class="print-meta-table">
          <tr><td>Date</td><td>${dateLabel}</td></tr>
          <tr><td>Time</td><td>${a.time ? formatTime(a.time) : "—"}</td></tr>
          <tr><td>Venue</td><td>${escapeHtml(a.venue || "—")}</td></tr>
          <tr><td>Organizer</td><td>${escapeHtml(a.organizer || "—")}</td></tr>
          <tr><td>Participants</td><td>${escapeHtml(a.participants || "—")}</td></tr>
          <tr><td>In-Charge</td><td>${escapeHtml(a.inCharge)}</td></tr>
        </table>
        <div class="print-notes-title">Notes</div>
        ${notesHtml}
      </div>
    `;
  }).join("");

  if (!cards) cards = `<p>No activities match the current filters.</p>`;

  printArea.innerHTML = `
    <h1>Activity Calendar</h1>
    <p class="print-sub">${subtitle} · ${filterNote}${searchNote} · Printed ${new Date().toLocaleString()}</p>
    ${cards}
  `;

  window.print();
}

// Prints the currently viewed month as a wall-calendar grid (not a card list).
function handlePrintCalendar() {
  const printArea = document.getElementById("printArea");
  const year = state.viewYear, month = state.viewMonth;
  const filtered = getFilteredActivities().filter((a) => isSameMonthOverlap(a, year, month));

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const byDay = {};
  for (let d = 1; d <= daysInMonth; d++) byDay[d] = [];
  filtered.forEach((a) => {
    const start = new Date(a.year, a.month, a.date);
    const end = new Date(a.endYear, a.endMonth, a.endDate);
    for (let d = 1; d <= daysInMonth; d++) {
      const dayTime = new Date(year, month, d).getTime();
      if (dayTime >= start.setHours(0,0,0,0) && dayTime <= end.setHours(0,0,0,0)) byDay[d].push(a);
    }
  });

  let cells = "";
  for (let i = 0; i < firstDay; i++) cells += `<td class="print-cal-empty"></td>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const items = byDay[d].map((a) => `<div class="print-cal-item">${a.time ? formatTime(a.time) + " " : ""}${escapeHtml(a.name)}</div>`).join("");
    cells += `<td><div class="print-cal-daynum">${d}</div>${items}</td>`;
    if ((firstDay + d) % 7 === 0) cells += `</tr><tr>`;
  }
  const totalCells = firstDay + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let i = 0; i < trailing; i++) cells += `<td class="print-cal-empty"></td>`;

  printArea.innerHTML = `
    <h1>Activity Calendar</h1>
    <p class="print-sub">${MONTH_NAMES[month]} ${year} · Printed ${new Date().toLocaleString()}</p>
    <table class="print-calendar">
      <thead><tr>${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => `<th>${d}</th>`).join("")}</tr></thead>
      <tbody><tr>${cells}</tr></tbody>
    </table>
  `;
  window.print();
}

/* ---------- backup ---------- */

// Downloads everything (activities + audit log) as a single JSON file the
// admin can keep locally, independent of Supabase.
async function downloadBackup() {
  showToast("Preparing backup...");
  const audit = await loadAudit();
  const payload = {
    exportedAt: new Date().toISOString(),
    activities: state.activities,
    auditLog: audit,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `activity-calendar-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Backup downloaded.");
}

/* ---------- fit to screen ---------- */

// Scales the calendar grid down (visually only) so the whole month is
// visible without scrolling — handy when presenting on a shared screen.
function toggleFitScreen() {
  state.fitMode = !state.fitMode;
  applyFitMode();
}

function applyFitMode() {
  const outer = document.getElementById("calendarFitOuter");
  const grid = document.getElementById("calendarGrid");
  const btn = document.getElementById("fitScreenBtn");
  if (!outer || !grid || !btn) return;

  if (!state.fitMode) {
    outer.classList.remove("fit-active");
    outer.style.height = "";
    grid.style.transform = "";
    grid.style.width = "";
    btn.classList.remove("active");
    btn.textContent = "⤢ Fit to Screen";
    return;
  }

  btn.classList.add("active");
  btn.textContent = "⤢ Exit Fit to Screen";

  // Measure the grid at natural size first.
  grid.style.transform = "";
  grid.style.width = "";
  outer.style.height = "";
  outer.classList.remove("fit-active");

  requestAnimationFrame(() => {
    const naturalHeight = grid.getBoundingClientRect().height;
    const naturalWidth = grid.getBoundingClientRect().width;
    const availableHeight = window.innerHeight - outer.getBoundingClientRect().top - 24;
    const availableWidth = outer.clientWidth;

    const scale = Math.min(1, availableHeight / naturalHeight, availableWidth / naturalWidth);

    grid.style.transformOrigin = "top left";
    grid.style.transform = `scale(${scale})`;
    grid.style.width = naturalWidth + "px";
    outer.style.height = (naturalHeight * scale) + "px";
    outer.classList.add("fit-active");
  });
}

function isSameMonthOverlap(a, year, month) {
  const monthStart = new Date(year, month, 1).getTime();
  const monthEnd = new Date(year, month + 1, 0).getTime();
  const aStart = new Date(a.year, a.month, a.date).getTime();
  const aEnd = new Date(a.endYear, a.endMonth, a.endDate).getTime();
  return aStart <= monthEnd && aEnd >= monthStart;
}

/* ---------- modal helpers ---------- */

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}
function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

/* ---------- misc ---------- */

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 2200);
}

function statusClass(status) {
  if (status === "Pending") return "status-pending";
  if (status === "Cancelled") return "status-cancelled";
  if (status === "Finished") return "status-finished";
  if (status === "Rescheduled") return "status-rescheduled";
  return "";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}
