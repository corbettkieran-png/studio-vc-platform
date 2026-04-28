const API_BASE = import.meta.env.VITE_API_URL || '/api';

function getToken() {
  return localStorage.getItem('svc_token');
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };

  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem('svc_token');
    localStorage.removeItem('svc_user');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Server returned an unexpected response. Please try again.');
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    if (data.detail) err.detail = data.detail;
    throw err;
  }
  return data;
}

// Auth
export const login = (email, password) =>
  request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const loginWithGoogle = (credential) =>
  request('/auth/google', { method: 'POST', body: JSON.stringify({ credential }) });

export const getMe = () => request('/auth/me');

export const createUser = (data) =>
  request('/auth/users', { method: 'POST', body: JSON.stringify(data) });

// Submissions
export const submitDeck = (formData) =>
  request('/submissions', { method: 'POST', body: formData });

export const getSubmissions = (params = {}) => {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  const qs = new URLSearchParams(clean).toString();
  return request(`/submissions?${qs}`);
};

export const getSubmission = (id) => request(`/submissions/${id}`);

export const getStats = () => request('/submissions/stats');

export const updateStatus = (id, status) =>
  request(`/submissions/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });

export const addNote = (id, content) =>
  request(`/submissions/${id}/notes`, { method: 'POST', body: JSON.stringify({ content }) });

export const addProgressCheck = (id, data) =>
  request(`/submissions/${id}/progress-check`, { method: 'POST', body: JSON.stringify(data) });

export const analyzeSubmission = (id) =>
  request(`/submissions/${id}/analyze`, { method: 'POST' });

export const deleteSubmission = (id) =>
  request(`/submissions/${id}`, { method: 'DELETE' });

export const setIntroSource = (id, data) =>
  request(`/submissions/${id}/intro-source`, { method: 'PATCH', body: JSON.stringify(data) });

// Contacts (intro source CRM)
export const getContacts = (params = {}) => {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  const qs = new URLSearchParams(clean).toString();
  return request(`/contacts?${qs}`);
};
export const getContact = (id) => request(`/contacts/${id}`);
export const createContact = (data) =>
  request('/contacts', { method: 'POST', body: JSON.stringify(data) });
export const updateContact = (id, data) =>
  request(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteContact = (id) =>
  request(`/contacts/${id}`, { method: 'DELETE' });
export const getContactsLeaderboard = () => request('/contacts/leaderboard');

export const getAnalytics = () => request('/submissions/analytics/overview');

// Activity
export const getActivity = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/activity?${qs}`);
};

// LP Outreach — current user's own connections
export const getMyTeamMember = () => request('/lp/me/team-member');
export const uploadMyLinkedInCSV = (formData) =>
  request('/lp/me/connections/upload', { method: 'POST', body: formData });

// LP Outreach
export const getLPTeam = () => request('/lp/team');
export const addLPTeamMember = (data) =>
  request('/lp/team', { method: 'POST', body: JSON.stringify(data) });
export const removeLPTeamMember = (id) =>
  request(`/lp/team/${id}`, { method: 'DELETE' });
export const uploadLinkedInCSV = (teamMemberId, formData) =>
  request(`/lp/team/${teamMemberId}/connections`, { method: 'POST', body: formData });
export const importLPTargets = (formData) =>
  request('/lp/targets/import', { method: 'POST', body: formData });
export const getLPTargets = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/lp/targets?${qs}`);
};
export const getLPTarget = (id) => request(`/lp/targets/${id}`);
export const updateLPTarget = (id, data) =>
  request(`/lp/targets/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const addLPActivity = (id, data) =>
  request(`/lp/targets/${id}/activity`, { method: 'POST', body: JSON.stringify(data) });
export const runLPMatching = () =>
  request('/lp/match', { method: 'POST' });
export const getLPStats = () => request('/lp/stats');

// Apollo integration
export const getApolloStatus = () => request('/lp/apollo/status');
export const getApolloContacts = (lpId) => request(`/lp/apollo/contacts/${lpId}`);
export const getLPCompanies = () => request('/lp/companies');
export const storeApolloContacts = (data) =>
  request('/lp/apollo/company-contacts', { method: 'POST', body: JSON.stringify(data) });

// Live Apollo enrichment (server-side, requires APOLLO_API_KEY on Railway)
export const getApolloKeyStatus = () => request('/lp/apollo/key-status');
export const apolloLiveSearch = (lpId, perPage = 25) =>
  request(`/lp/apollo/live-search/${lpId}`, {
    method: 'POST',
    body: JSON.stringify({ per_page: perPage }),
  });
export const apolloBulkEnrich = (limit = 50) =>
  request('/lp/apollo/bulk-enrich', {
    method: 'POST',
    body: JSON.stringify({ only_missing: true, limit }),
  });

// Known contacts (warm intro flags)
export const flagKnownContact = (contactId, note) =>
  request(`/lp/apollo/contacts/${contactId}/know`, { method: 'POST', body: JSON.stringify({ relationship_note: note }) });
export const unflagKnownContact = (contactId) =>
  request(`/lp/apollo/contacts/${contactId}/know`, { method: 'DELETE' });

// Apollo Deep Enrichment (People Match - gets LinkedIn URLs, emails)
export const enrichApolloContact = (contactId, { linkedin_url, override_name } = {}) =>
  request(`/lp/apollo/contacts/${contactId}/enrich`, {
    method: 'POST',
    body: JSON.stringify({ linkedin_url, override_name }),
  });

export const sendIntro = (lpId, { subject, body, to_email }) =>
  request(`/lp/targets/${lpId}/send-intro`, {
    method: 'POST',
    body: JSON.stringify({ subject, body, to_email }),
  });
export const enrichApolloContactsBatch = (lpId) =>
  request(`/lp/apollo/contacts/enrich-batch/${lpId}`, { method: 'POST' });

// LinkedIn Enrichment (People Data Labs)
export const enrichLPTarget = (targetId) =>
  request(`/lp/linkedin/enrich-target/${targetId}`, { method: 'POST' });
export const enrichLinkedInProfile = (linkedin_url, lp_target_id, apollo_contact_id) =>
  request('/lp/linkedin/enrich', { method: 'POST', body: JSON.stringify({ linkedin_url, lp_target_id, apollo_contact_id }) });
export const getLinkedInEnrichment = (targetId) =>
  request(`/lp/linkedin/enrichment/${targetId}`);

// Clay Integration
export const getClaySettings = () => request('/lp/clay/settings');
export const saveClaySettings = (data) =>
  request('/lp/clay/settings', { method: 'POST', body: JSON.stringify(data) });
export const exportToClay = (data = {}) =>
  request('/lp/clay/export', { method: 'POST', body: JSON.stringify(data) });
export const importClayCSV = (formData) =>
  request('/lp/clay/import-csv', { method: 'POST', body: formData });
export const getClayWebhookUrl = () => request('/lp/clay/webhook-url');

// Manual Connections (Navigator-sourced warm paths)
export const getManualConnections = (lpId) => request(`/lp/targets/${lpId}/connections`);
export const addManualConnection = (lpId, data) =>
  request(`/lp/targets/${lpId}/connections`, { method: 'POST', body: JSON.stringify(data) });
export const deleteManualConnection = (lpId, connId) =>
  request(`/lp/targets/${lpId}/connections/${connId}`, { method: 'DELETE' });
