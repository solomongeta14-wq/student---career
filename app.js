"use strict";

const state = {
  user: null,
  csrfToken: null,
  jobs: [],
  events: [],
  activeCategory: "All roles",
  activeView: "all",
  selectedJobId: null,
  authMode: "login",
  preferredRole: "graduate",
  toastTimer: null
};

const byId = id => document.getElementById(id);
const keywordInput = byId("keyword");
const locationSelect = byId("location");
const jobsGrid = byId("jobs-grid");
const mobileMenu = byId("mobile-menu");
const sidebar = byId("sidebar");
const mobileMenuBackdrop = byId("mobile-menu-backdrop");

function setMobileMenuOpen(open) {
  sidebar.classList.toggle("mobile-open", open);
  mobileMenuBackdrop.hidden = !open;
  mobileMenu.setAttribute("aria-expanded", String(open));
  mobileMenu.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = new Headers(options.headers || {});
  const request = { method, headers, credentials: "same-origin" };
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    request.body = JSON.stringify(options.body);
  }
  if (method !== "GET" && state.csrfToken) headers.set("X-CSRF-Token", state.csrfToken);

  const response = await fetch(path, request);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function safely(action) {
  try {
    await action();
  } catch (error) {
    if (error.status >= 500 || !error.status) console.error(error);
    showToast(error.message || "Something went wrong. Please try again.");
  }
}

function setAuthMode(mode, preferredRole = "graduate") {
  state.authMode = mode;
  state.preferredRole = preferredRole;
  const register = mode === "register";
  byId("auth-title").textContent = register ? "Create your account" : "Welcome back";
  byId("auth-intro").textContent = register
    ? "Join the community and take your next career step."
    : "Sign in to manage your career connections.";
  byId("auth-submit").textContent = register ? "Create account" : "Sign in";
  byId("auth-switch").textContent = register ? "Already have an account? Sign in" : "New here? Create an account";
  byId("auth-name-field").hidden = !register;
  byId("auth-role-field").hidden = !register;
  byId("auth-company-field").hidden = !register || preferredRole !== "employer";
  byId("auth-form").elements.role.value = preferredRole;
  byId("auth-form").elements.name.required = register;
  byId("auth-form").elements.companyName.required = register && preferredRole === "employer";
  byId("auth-form").elements.password.autocomplete = register ? "new-password" : "current-password";
}

function openAuth(mode = "login", role = "graduate") {
  setAuthMode(mode, role);
  byId("auth-dialog").showModal();
}

function renderAccount() {
  const user = state.user;
  const signedIn = Boolean(user);
  const isEmployer = signedIn && user.role === "employer";
  byId("auth-button").textContent = signedIn ? "Sign out" : "Sign in";
  byId("profile-avatar").hidden = !signedIn;
  byId("profile-avatar").textContent = signedIn ? user.name.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase() : "";
  byId("profile-avatar").setAttribute("aria-label", signedIn ? `Open ${user.name}'s profile` : "Open profile");
  byId("profile-name").textContent = signedIn ? user.name : "Guest";
  byId("profile-role").textContent = signedIn
    ? (isEmployer ? user.companyName : (user.major || "Graduate / student"))
    : "Sign in to get started";
  byId("nav-applications").hidden = isEmployer;
  byId("nav-saved").hidden = isEmployer;
  byId("nav-my-listings").hidden = !isEmployer;
  byId("nav-applicants").hidden = !isEmployer;
  byId("mobile-applications").hidden = isEmployer;
  byId("mobile-saved").hidden = isEmployer;
  byId("mobile-listings").hidden = !isEmployer;
  byId("mobile-applicants").hidden = !isEmployer;
  byId("open-employer-form").textContent = isEmployer ? "Post a role →" : "Employer sign up →";

  const profileProgress = byId("profile-progress");
  if (signedIn && !isEmployer) {
    profileProgress.hidden = false;
    const completed = [user.major, user.graduationYear, user.bio].filter(Boolean).length;
    const percent = 35 + completed * 20;
    profileProgress.setAttribute("aria-label", `Profile is ${percent}% complete`);
    profileProgress.querySelector(".progress-head strong").textContent = `${percent}%`;
    profileProgress.querySelector(".progress-track span").style.width = `${percent}%`;
    byId("profile-progress-link").textContent = percent >= 95 ? "Edit your profile →" : "Complete your profile →";
  } else {
    profileProgress.hidden = true;
  }

  byId("welcome-title").innerHTML = `Your next chapter<br>starts here, ${escapeHtml(signedIn ? user.name.split(/\s+/)[0] : "there")}.`;
  byId("mentor-request").textContent = user && user.role === "graduate" ? "Request a mentor →" : "Explore mentorship →";
  updateCounts();
}

function updateCounts() {
  const saved = state.jobs.filter(job => job.saved).length;
  const applications = state.jobs.filter(job => job.applied).length;
  byId("saved-count").textContent = saved;
  byId("application-count").textContent = applications;
  byId("listing-count").textContent = state.jobs.filter(job => job.applicantCount !== undefined).length;
}

function selectedCategory() {
  return state.activeCategory === "All roles" ? "" : state.activeCategory;
}

function jobQueryUrl() {
  const params = new URLSearchParams();
  params.set("view", state.activeView === "applicants" ? "all" : state.activeView);
  if (keywordInput.value.trim()) params.set("q", keywordInput.value.trim());
  if (locationSelect.value) params.set("location", locationSelect.value);
  if (selectedCategory()) params.set("category", selectedCategory());
  return `/api/jobs?${params}`;
}

async function loadJobs() {
  if (state.activeView === "applicants") {
    await loadApplicants();
    return;
  }
  const result = await api(jobQueryUrl());
  state.jobs = result.jobs;
  renderJobs();
  updateCounts();
}

function renderJobs() {
  const employer = state.user && state.user.role === "employer";
  const viewingMine = state.activeView === "mine";
  const section = byId("opportunities");
  const applicantsSection = byId("applicants-section");
  section.hidden = state.activeView === "applicants";
  applicantsSection.hidden = state.activeView !== "applicants";
  if (state.activeView === "applicants") return;

  byId("job-filters").hidden = viewingMine;
  byId("opportunities-title").textContent = viewingMine ? "Your opportunities" : "Opportunities for you";
  byId("clear-filters").hidden = viewingMine;
  byId("results-label").textContent = viewingMine
    ? `${state.jobs.length} job ${state.jobs.length === 1 ? "post" : "posts"} published by your organization`
    : state.activeView === "saved"
      ? `${state.jobs.length} saved ${state.jobs.length === 1 ? "role" : "roles"}`
      : state.activeView === "applications"
        ? `${state.jobs.length} ${state.jobs.length === 1 ? "application" : "applications"} in your tracker`
        : `${state.jobs.length} ${state.jobs.length === 1 ? "opportunity" : "opportunities"} picked for you`;

  if (!state.jobs.length) {
    const emptyMessage = state.activeView === "saved" ? "No saved roles yet. Save a role to keep it close." :
      state.activeView === "applications" ? "No applications yet. Find a role that feels right and apply when you're ready." :
        viewingMine ? "Your organization has not posted any roles yet." :
          "No roles match those filters yet. Try another search or view all roles.";
    jobsGrid.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    return;
  }

  jobsGrid.innerHTML = state.jobs.map(job => `
    <article class="job-card">
      <div class="job-top">
        <div class="company">
          <div class="company-logo ${escapeHtml(job.logoClass || "logo-sage")}" aria-hidden="true">${escapeHtml(job.logo)}</div>
          <div style="min-width:0">
            <div class="company-name">${escapeHtml(job.company)}</div>
            <div class="job-title">${escapeHtml(job.title)}</div>
          </div>
        </div>
        ${!employer ? `<button class="save-button ${job.saved ? "saved" : ""}" type="button" data-save="${job.id}" aria-label="${job.saved ? "Remove saved " : "Save "}${escapeHtml(job.title)}" aria-pressed="${job.saved}">
          <svg viewBox="0 0 24 24"><path d="M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18l-6-4-6 4z"/></svg>
        </button>` : ""}
      </div>
      <p class="job-description">${escapeHtml(job.description)}</p>
      <div class="job-meta"><span class="meta-pill">${escapeHtml(job.location)}</span><span class="meta-pill">${escapeHtml(job.type)}</span><span class="meta-pill">${escapeHtml(job.category)}</span></div>
      <div class="job-bottom">
        <div>
          <div class="salary">${escapeHtml(job.salary)} <span>${escapeHtml(job.payPeriod)}</span></div>
          <div class="posted">${viewingMine ? `${job.applicantCount || 0} applicants` : `Posted ${escapeHtml(job.posted)}`}</div>
        </div>
        <button class="apply-button" type="button" data-apply="${job.id}">${employer ? "View applicants" : job.applied ? "Applied" : "View role"} <span aria-hidden="true">&rarr;</span></button>
      </div>
    </article>`).join("");
}

function formatEventDate(value) {
  const date = new Date(value);
  return {
    day: new Intl.DateTimeFormat(undefined, { day: "2-digit", timeZone: "UTC" }).format(date),
    month: new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" }).format(date)
  };
}

async function loadEvents() {
  const result = await api("/api/events");
  state.events = result.events;
  byId("event-list").innerHTML = state.events.length ? state.events.map(event => {
    const date = formatEventDate(event.startsAt);
    return `<div class="event">
      <div class="date-box"><strong>${escapeHtml(date.day)}</strong><span>${escapeHtml(date.month)}</span></div>
      <div class="event-info"><strong>${escapeHtml(event.title)}</strong><span>${escapeHtml(event.time)} · ${escapeHtml(event.location)}</span></div>
      <button class="event-join" type="button" data-rsvp="${event.id}" aria-pressed="${event.registered}">${event.registered ? "Going" : "Join"}</button>
    </div>`;
  }).join("") : '<div class="empty-state">No events are scheduled right now.</div>';
}

function renderApplicantCards(applications) {
  const grid = byId("applicants-grid");
  if (!applications.length) {
    grid.innerHTML = '<div class="empty-state">No applications have arrived yet. Your published roles will appear here as graduates apply.</div>';
    return;
  }
  const statuses = ["submitted", "reviewed", "interview", "offered", "rejected"];
  grid.innerHTML = applications.map(application => `
    <article class="applicant-card">
      <h3>${escapeHtml(application.applicant_name)}</h3>
      <a class="applicant-job" href="mailto:${encodeURIComponent(application.applicant_email)}">${escapeHtml(application.applicant_email)}</a>
      <p>Applied for <strong>${escapeHtml(application.job_title)}</strong><br>
        ${escapeHtml(application.major || "Field of study not provided")}${application.graduation_year ? ` · Class of ${escapeHtml(application.graduation_year)}` : ""}
      </p>
      <p>${escapeHtml(application.bio || "No profile introduction provided yet.")}</p>
      <label class="form-field">Application status
        <select data-app-status="${application.id}">
          ${statuses.map(status => `<option value="${status}" ${status === application.status ? "selected" : ""}>${status.charAt(0).toUpperCase() + status.slice(1)}</option>`).join("")}
        </select>
      </label>
    </article>`).join("");
}

async function loadApplicants() {
  const result = await api("/api/employer/applications");
  renderApplicantCards(result.applications);
}

async function refreshCounters() {
  if (!state.user) {
    byId("saved-count").textContent = "0";
    byId("application-count").textContent = "0";
    byId("listing-count").textContent = "0";
    return;
  }
  if (state.user.role === "graduate") {
    const [saved, applications] = await Promise.all([
      api("/api/jobs?view=saved"),
      api("/api/jobs?view=applications")
    ]);
    byId("saved-count").textContent = saved.jobs.length;
    byId("application-count").textContent = applications.jobs.length;
  } else {
    const listings = await api("/api/jobs?view=mine");
    byId("listing-count").textContent = listings.jobs.length;
  }
}

async function refreshSession() {
  const session = await api("/api/me");
  state.user = session.user;
  state.csrfToken = session.csrfToken;
  renderAccount();
  await Promise.all([loadJobs(), loadEvents(), refreshCounters()]);
}

function setActiveChip(category) {
  state.activeCategory = category;
  document.querySelectorAll(".chip").forEach(chip => {
    const selected = chip.dataset.category === category;
    chip.classList.toggle("selected", selected);
    chip.setAttribute("aria-pressed", String(selected));
  });
}

function switchView(view) {
  state.activeView = view;
  if (view === "all" || view === "saved" || view === "applications" || view === "mine") {
    byId("opportunities").hidden = false;
    byId("applicants-section").hidden = true;
  }
  if (view === "saved" || view === "applications" || view === "mine" || view === "applicants") {
    setActiveChip("All roles");
    keywordInput.value = "";
    locationSelect.value = "";
  }
  if (view === "applicants") {
    byId("opportunities").hidden = true;
    byId("applicants-section").hidden = false;
  }
  void safely(loadJobs);
}

function openProfile() {
  if (!state.user) {
    openAuth();
    return;
  }
  const form = byId("profile-form");
  form.elements.name.value = state.user.name;
  form.elements.major.value = state.user.major || "";
  form.elements.graduationYear.value = state.user.graduationYear || "";
  form.elements.bio.value = state.user.bio || "";
  form.elements.companyName.value = state.user.companyName || "";
  const isEmployer = state.user.role === "employer";
  byId("profile-company-field").hidden = !isEmployer;
  byId("profile-major-field").hidden = isEmployer;
  byId("profile-year-field").hidden = isEmployer;
  byId("profile-dialog").showModal();
}

byId("search-form").addEventListener("submit", event => {
  event.preventDefault();
  switchView("all");
  document.getElementById("opportunities").scrollIntoView({ behavior: "smooth", block: "start" });
});

keywordInput.addEventListener("input", () => {
  if (state.activeView !== "all" && state.activeView !== "mine") switchView("all");
  void safely(loadJobs);
});
locationSelect.addEventListener("change", () => void safely(loadJobs));

document.querySelectorAll(".chip").forEach(chip => {
  chip.addEventListener("click", () => {
    setActiveChip(chip.dataset.category);
    switchView("all");
  });
});

byId("clear-filters").addEventListener("click", () => {
  keywordInput.value = "";
  locationSelect.value = "";
  setActiveChip("All roles");
  switchView("all");
});

mobileMenu.addEventListener("click", () => {
  setMobileMenuOpen(mobileMenu.getAttribute("aria-expanded") !== "true");
});
mobileMenuBackdrop.addEventListener("click", () => setMobileMenuOpen(false));
sidebar.addEventListener("click", event => {
  if (event.target.closest("a")) setMobileMenuOpen(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") setMobileMenuOpen(false);
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 760) setMobileMenuOpen(false);
});

document.addEventListener("click", event => {
  const saveButton = event.target.closest("[data-save]");
  if (saveButton) {
    if (!state.user) {
      openAuth("login", "graduate");
      return;
    }
    if (state.user.role !== "graduate") {
      showToast("Saved jobs are available to graduate accounts.");
      return;
    }
    const job = state.jobs.find(item => item.id === Number(saveButton.dataset.save));
    void safely(async () => {
      await api(`/api/jobs/${job.id}/save`, { method: job.saved ? "DELETE" : "POST" });
      await Promise.all([loadJobs(), refreshCounters()]);
      showToast(job.saved ? "Removed from your saved roles." : "Role saved to your account.");
    });
    return;
  }

  const applyButton = event.target.closest("[data-apply]");
  if (applyButton) {
    const job = state.jobs.find(item => item.id === Number(applyButton.dataset.apply));
    if (state.user && state.user.role === "employer") {
      switchView("applicants");
      return;
    }
    if (job.applied) {
      showToast("This role is already in your application tracker.");
      return;
    }
    state.selectedJobId = job.id;
    byId("dialog-company").textContent = job.company;
    byId("dialog-title").textContent = job.title;
    byId("dialog-meta").innerHTML = [job.location, job.type, job.category]
      .map(value => `<span class="meta-pill">${escapeHtml(value)}</span>`).join("");
    byId("dialog-description").textContent = job.description;
    byId("dialog-salary").textContent = `${job.salary} ${job.payPeriod}`;
    byId("submit-application").textContent = state.user ? "Apply now →" : "Sign in to apply";
    byId("submit-application").disabled = Boolean(state.user && state.user.role !== "graduate");
    byId("role-dialog").showModal();
    return;
  }

  const viewLink = event.target.closest("[data-view]");
  if (viewLink) {
    event.preventDefault();
    const view = viewLink.dataset.view;
    const requiredRole = view === "saved" || view === "applications" ? "graduate" : "employer";
    if (!state.user) {
      openAuth("login", requiredRole);
      return;
    }
    if (state.user.role !== requiredRole) {
      showToast(`This section is available to ${requiredRole} accounts.`);
      return;
    }
    switchView(view);
    document.getElementById(view === "applicants" ? "applicants-section" : "opportunities")
      .scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const rsvpButton = event.target.closest("[data-rsvp]");
  if (rsvpButton) {
    if (!state.user) {
      openAuth("login", "graduate");
      return;
    }
    if (state.user.role !== "graduate") {
      showToast("Event registration is available to graduate accounts.");
      return;
    }
    void safely(async () => {
      const eventId = rsvpButton.dataset.rsvp;
      const registered = rsvpButton.getAttribute("aria-pressed") === "true";
      await api(`/api/events/${eventId}/rsvp`, { method: registered ? "DELETE" : "POST" });
      await loadEvents();
      showToast(registered ? "Your event RSVP was cancelled." : "You're registered! Event details are on the event page.");
    });
    return;
  }

  const profileLink = event.target.closest("[data-profile], [data-open-profile]");
  if (profileLink || event.target.closest("#profile-open, #profile-avatar")) {
    event.preventDefault();
    openProfile();
    return;
  }

  const toastTarget = event.target.closest("[data-toast]");
  if (toastTarget) {
    event.preventDefault();
    showToast(toastTarget.dataset.toast);
  }
});

byId("submit-application").addEventListener("click", () => {
  if (!state.user) {
    byId("role-dialog").close();
    openAuth("login", "graduate");
    return;
  }
  if (state.user.role !== "graduate" || state.selectedJobId === null) return;
  void safely(async () => {
    await api(`/api/jobs/${state.selectedJobId}/applications`, { method: "POST", body: {} });
    const title = byId("dialog-title").textContent;
    byId("role-dialog").close();
    state.activeView = "applications";
    await Promise.all([loadJobs(), refreshCounters()]);
    showToast(`Application sent for ${title}. Track updates in My applications.`);
  });
});

byId("auth-switch").addEventListener("click", () => {
  setAuthMode(state.authMode === "login" ? "register" : "login", state.preferredRole);
});

byId("auth-form").elements.role.addEventListener("change", event => {
  setAuthMode("register", event.target.value);
});

byId("auth-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = event.currentTarget;
  void safely(async () => {
    const formData = new FormData(form);
    const payload = {
      email: formData.get("email"),
      password: formData.get("password")
    };
    if (state.authMode === "register") {
      payload.name = formData.get("name");
      payload.role = formData.get("role");
      payload.companyName = formData.get("companyName");
    }
    const result = await api(`/api/auth/${state.authMode === "register" ? "register" : "login"}`, {
      method: "POST",
      body: payload
    });
    state.user = result.user;
    state.csrfToken = result.csrfToken;
    state.activeView = "all";
    form.reset();
    byId("auth-dialog").close();
    renderAccount();
    await Promise.all([loadJobs(), loadEvents(), refreshCounters()]);
    showToast(`Welcome${state.user.name ? `, ${state.user.name.split(/\s+/)[0]}` : ""}!`);
  });
});

byId("auth-button").addEventListener("click", () => {
  if (!state.user) {
    openAuth();
    return;
  }
  void safely(async () => {
    await api("/api/auth/logout", { method: "POST", body: {} });
    state.user = null;
    state.csrfToken = null;
    state.activeView = "all";
    renderAccount();
    await Promise.all([loadJobs(), loadEvents()]);
    showToast("You have signed out.");
  });
});

byId("profile-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = event.currentTarget;
  void safely(async () => {
    const formData = new FormData(form);
    const payload = {
      name: formData.get("name"),
      major: formData.get("major"),
      graduationYear: formData.get("graduationYear"),
      bio: formData.get("bio"),
      companyName: formData.get("companyName")
    };
    const result = await api("/api/profile", { method: "PATCH", body: payload });
    state.user = result.user;
    form.reset();
    byId("profile-dialog").close();
    renderAccount();
    showToast("Your profile has been saved.");
  });
});

byId("employer-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!state.user || state.user.role !== "employer") {
    showToast("Sign in with an employer account to post an opportunity.");
    return;
  }
  const form = event.currentTarget;
  void safely(async () => {
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    await api("/api/jobs", { method: "POST", body: payload });
    form.reset();
    byId("employer-dialog").close();
    switchView("mine");
    await refreshCounters();
    showToast("Your opportunity is live for graduates to discover.");
  });
});

byId("open-employer-form").addEventListener("click", () => {
  if (!state.user) {
    openAuth("register", "employer");
  } else if (state.user.role === "employer") {
    byId("employer-dialog").showModal();
  } else {
    showToast("Sign in with an employer account to post opportunities.");
  }
});

byId("mentor-request").addEventListener("click", () => {
  if (!state.user) {
    openAuth("login", "graduate");
    return;
  }
  if (state.user.role !== "graduate") {
    showToast("Mentor matching is available to graduate accounts.");
    return;
  }
  void safely(async () => {
    const result = await api("/api/mentorship-requests", { method: "POST", body: {} });
    showToast(result.status === "requested" ? "Your mentor request is in. We'll be in touch." : `Mentor request status: ${result.status}.`);
  });
});

byId("applicants-grid").addEventListener("change", event => {
  const select = event.target.closest("[data-app-status]");
  if (!select) return;
  void safely(async () => {
    await api(`/api/employer/applications/${select.dataset.appStatus}`, {
      method: "PATCH",
      body: { status: select.value }
    });
    showToast("Application status updated.");
  });
});

byId("today-label").textContent = new Intl.DateTimeFormat(undefined, {
  weekday: "long", month: "long", day: "numeric"
}).format(new Date());
setAuthMode("login");
void safely(refreshSession);
