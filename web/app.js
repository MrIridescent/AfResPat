const browseView = document.querySelector('#browse-view');
const detailView = document.querySelector('#detail-view');
const listStatus = document.querySelector('#list-status');
const recordList = document.querySelector('#record-list');
const resultCount = document.querySelector('#result-count');
const pageActions = document.querySelector('#page-actions');
const loadMoreButton = document.querySelector('#load-more');
const searchInput = document.querySelector('#search');
const kindFilter = document.querySelector('#kind-filter');
const languageFilter = document.querySelector('#language-filter');
const detailStatus = document.querySelector('#detail-status');
const detailContent = document.querySelector('#detail-content');
const detailTitle = document.querySelector('#detail-title');
const detailMeta = document.querySelector('#detail-meta');
const detailFacts = document.querySelector('#detail-facts');
const translationList = document.querySelector('#translation-list');

const records = [];
let nextOffset = 0;
let hasMore = true;
let listController = null;
let detailController = null;
let routeVersion = 0;
let listError = '';

function text(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function label(value, fallback) {
  const source = text(value, '');
  return source ? source.replace(/[_-]+/g, ' ') : fallback;
}

function dateLabel(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(value)) return 'Date not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) return 'Date not available';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function safeSource(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function setStatus(container, message, retry) {
  container.replaceChildren();
  if (!message) return;
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  container.append(paragraph);
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button-outline';
    button.textContent = 'Try again';
    button.addEventListener('click', retry);
    container.append(button);
  }
}

async function requestJson(path, signal) {
  const response = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) {
    if (response.status === 404) throw new Error('not_found');
    throw new Error('request_failed');
  }
  return response.json();
}

function updateOptions(select, values, fallback) {
  const selected = select.value;
  select.replaceChildren(new Option(fallback, ''));
  [...new Set(values.filter(value => typeof value === 'string' && value.trim()))]
    .sort((a, b) => a.localeCompare(b))
    .forEach(value => select.add(new Option(label(value, value), value)));
  select.value = [...select.options].some(option => option.value === selected) ? selected : '';
}

function renderList() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const filtered = records.filter(record => {
    const matchesQuery = !query || [record.title, record.id, record.kind, record.primaryLanguage]
      .some(value => value.toLocaleLowerCase().includes(query));
    return matchesQuery && (!kindFilter.value || record.kind === kindFilter.value)
      && (!languageFilter.value || record.primaryLanguage === languageFilter.value);
  });

  const entries = document.createDocumentFragment();
  filtered.forEach(record => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'record-link';
    link.href = `#submission=${encodeURIComponent(record.id)}`;

    const index = document.createElement('span');
    index.className = 'record-index';
    index.setAttribute('aria-hidden', 'true');
    index.textContent = String(records.indexOf(record) + 1).padStart(2, '0');

    const body = document.createElement('span');
    body.className = 'record-body';
    const title = document.createElement('span');
    title.className = 'record-title';
    title.textContent = record.title;
    const meta = document.createElement('span');
    meta.className = 'record-meta';
    [label(record.kind, 'Type not specified'), text(record.primaryLanguage, 'Language not specified'), dateLabel(record.createdAt)].forEach(value => {
      const part = document.createElement('span');
      part.textContent = value;
      meta.append(part);
    });
    body.append(title, meta);

    const arrow = document.createElement('span');
    arrow.className = 'record-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    link.append(index, body, arrow);
    item.append(link);
    entries.append(item);
  });
  recordList.replaceChildren(entries);
  resultCount.textContent = `${filtered.length} shown · ${records.length} loaded`;
  pageActions.hidden = !hasMore || nextOffset === 0;

  if (listController) {
    setStatus(listStatus, records.length ? 'Loading more records…' : 'Loading public records…');
  } else if (listError) {
    setStatus(listStatus, listError, loadPage);
  } else if (records.length === 0) {
    setStatus(listStatus, 'No public records are available right now.');
  } else if (filtered.length === 0) {
    setStatus(listStatus, 'No matches in the pages loaded so far. Try different terms or load the next page.');
  } else {
    setStatus(listStatus, '');
  }
}

async function loadPage() {
  if (listController || !hasMore) return;
  const controller = new AbortController();
  listController = controller;
  listError = '';
  loadMoreButton.disabled = true;
  loadMoreButton.textContent = 'Loading next page…';
  renderList();

  try {
    const data = await requestJson(`/api/submissions?limit=20&offset=${nextOffset}`, controller.signal);
    if (controller.signal.aborted) return;
    if (!data || !Array.isArray(data.items)) throw new Error('invalid_response');
    const page = data.items;
    page.forEach(item => {
      if (!item || typeof item.id !== 'string' || !item.id.trim()) return;
      if (records.some(record => record.id === item.id)) return;
      records.push({
        id: item.id,
        title: text(item.title, 'Untitled record'),
        kind: text(item.kind, ''),
        primaryLanguage: text(item.primaryLanguage, ''),
        createdAt: item.createdAt
      });
    });
    nextOffset += page.length;
    hasMore = page.length === 20 && nextOffset <= 1000;
    updateOptions(kindFilter, records.map(record => record.kind), 'All types');
    updateOptions(languageFilter, records.map(record => record.primaryLanguage), 'All languages');
  } catch (error) {
    if (error.name !== 'AbortError' && !controller.signal.aborted) {
      listError = records.length
        ? 'The next page could not be loaded. Your loaded records are still available.'
        : 'Public records could not be loaded. Check your connection and try again.';
    }
  } finally {
    if (listController === controller) {
      listController = null;
      loadMoreButton.disabled = false;
      loadMoreButton.replaceChildren(document.createTextNode('Load next 20 records '));
      const arrow = document.createElement('span');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '↗';
      loadMoreButton.append(arrow);
      renderList();
    }
  }
}

function addFact(term, value, href) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  if (href) {
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = href;
    dd.append(link);
  } else {
    dd.textContent = value;
  }
  detailFacts.append(dt, dd);
}

function renderDetail(data, id) {
  const translations = Array.isArray(data.translations) ? data.translations.filter(item => item && typeof item === 'object') : [];
  const title = text(data.title, '') || text(translations.find(item => item.language === data.primaryLanguage)?.title, '')
    || text(translations.find(item => item.title)?.title, 'Untitled record');
  detailTitle.textContent = title;
  document.title = `${title} | Research archive`;
  detailMeta.replaceChildren();
  [label(data.kind, 'Type not specified'), dateLabel(data.createdAt)].forEach(value => {
    const span = document.createElement('span');
    span.textContent = value;
    detailMeta.append(span);
  });

  detailFacts.replaceChildren();
  addFact('Record ID', id);
  addFact('Record type', label(data.kind, 'Not specified'));
  addFact('Primary language', text(data.primaryLanguage, 'Not specified'));
  addFact('Date added', dateLabel(data.createdAt));
  const source = safeSource(data.sourceUrl);
  addFact('Source', source ? '' : 'Not available', source);
  if (data.hasFile) addFact('Public PDF', '', `/api/submissions/${encodeURIComponent(id)}/file`);

  translationList.replaceChildren();
  if (!translations.length) {
    const empty = document.createElement('p');
    empty.className = 'translations-empty';
    empty.textContent = 'No translations are available for this record.';
    translationList.append(empty);
  }
  translations.forEach(translation => {
    const article = document.createElement('article');
    article.className = 'translation';
    const language = document.createElement('p');
    language.className = 'translation-language';
    language.textContent = text(translation.language, 'Language not specified');
    const heading = document.createElement('h3');
    heading.textContent = text(translation.title, 'Untitled translation');
    const abstract = document.createElement('p');
    abstract.textContent = text(translation.abstract, 'No abstract available for this translation.');
    if (!text(translation.abstract, '')) abstract.className = 'missing-abstract';
    article.append(language, heading, abstract);
    translationList.append(article);
  });
  detailContent.hidden = false;
}

function routeId() {
  if (!location.hash.startsWith('#submission=')) return null;
  try {
    return decodeURIComponent(location.hash.slice('#submission='.length)) || null;
  } catch {
    return null;
  }
}

async function renderRoute(focusView = false) {
  const version = ++routeVersion;
  if (detailController) detailController.abort();
  detailController = null;
  const id = routeId();
  browseView.hidden = Boolean(id);
  detailView.hidden = !id;
  if (location.hash !== '#contribute') window.scrollTo(0, 0);

  if (!id) {
    document.title = 'Research archive | Public research library';
    if (focusView && location.hash !== '#contribute') {
      const heading = document.querySelector('#page-title');
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    if (listController === null && records.length === 0 && hasMore && !listError) {
      loadPage();
    } else {
      renderList();
    }
    return;
  }

  document.title = 'Record | Research archive';
  detailContent.hidden = true;
  setStatus(detailStatus, 'Loading record…');
  if (focusView) {
    const backLink = detailView.querySelector('.back-link');
    backLink.focus({ preventScroll: true });
  }
  const controller = new AbortController();
  detailController = controller;
  const retry = () => { if (version === routeVersion) renderRoute(); };
  try {
    const data = await requestJson(`/api/submissions/${encodeURIComponent(id)}`, controller.signal);
    if (version !== routeVersion || controller.signal.aborted) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_response');
    renderDetail(data, id);
    setStatus(detailStatus, '');
  } catch (error) {
    if (version !== routeVersion || controller.signal.aborted) return;
    setStatus(detailStatus, error.message === 'not_found'
      ? 'This record was not found or is not public. Return to the archive to continue browsing.'
      : 'This record could not be loaded. Check your connection and try again.', error.message === 'not_found' ? null : retry);
  } finally {
    if (detailController === controller) detailController = null;
  }
}

[searchInput, kindFilter, languageFilter].forEach(control => {
  control.addEventListener(control === searchInput ? 'input' : 'change', renderList);
});
loadMoreButton.addEventListener('click', loadPage);
window.addEventListener('hashchange', () => renderRoute(true));
renderRoute();

const guest = document.querySelector('#account-guest');
const member = document.querySelector('#account-member');
const accountStatus = document.querySelector('#account-status');
const myStatus = document.querySelector('#my-status');
const curationStatus = document.querySelector('#curation-status');
const curationPanel = document.querySelector('#curation-panel');
let token = sessionStorage.getItem('research-session');
let currentUser = null;

async function api(path, options = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof Blob)) headers['content-type'] = 'application/json';
  if (options.body instanceof Blob) headers['content-type'] = 'application/pdf';
  let response;
  try {
    response = await fetch(path, { method: options.method || 'GET', headers, body: options.body instanceof Blob ? options.body : options.body && JSON.stringify(options.body) });
  } catch {
    throw new Error('Cannot reach the repository. Check your connection and retry.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      invalid_account: 'Enter a valid email and a password of 12–128 characters.',
      account_exists: 'This email is already registered.',
      invalid_credentials: 'Email or password is incorrect.',
      rate_limited: 'Too many attempts. Wait 15 minutes and try again.',
      forbidden: 'This account cannot perform that action.',
      bootstrap_closed: 'The first curator has already been created.',
      invalid_submission: 'Check the language, title, abstract, and HTTPS source URL.',
      invalid_file: 'Upload a valid PDF no larger than 10 MiB.',
      storage_unavailable: 'PDF storage is not available; your metadata was deposited privately.',
      database_unavailable: 'The repository database is unavailable.',
      not_found_or_not_pending: 'This item is no longer awaiting your review.'
    };
    if (response.status === 401) {
      token = null;
      sessionStorage.removeItem('research-session');
      showMember(null);
    }
    throw new Error(messages[data.error] || `Request failed (${response.status}).`);
  }
  return data;
}

function showMember(user) {
  currentUser = user;
  guest.hidden = Boolean(user);
  member.hidden = !user;
  curationPanel.hidden = user?.role !== 'curator';
  document.querySelector('#member-identity').textContent = user ? `${user.email} · ${user.role} (local account)` : '';
  if (!user) {
    document.querySelector('#my-list').replaceChildren();
    document.querySelector('#curation-list').replaceChildren();
    myStatus.textContent = '';
    curationStatus.textContent = '';
  }
}

async function authenticate(event, path, fields) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  accountStatus.textContent = 'Connecting…';
  try {
    const result = await api(path, { method: 'POST', body: Object.fromEntries(fields.map(([key, selector]) => [key, form.querySelector(selector).value])) });
    token = result.token;
    sessionStorage.setItem('research-session', token);
    showMember(result.user);
    form.reset();
    accountStatus.textContent = 'Signed in. You can now deposit work privately.';
    await refreshMember();
  } catch (error) {
    accountStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

const loginFields = [['email', '[type="email"]'], ['password', '[type="password"]']];
document.querySelector('#register-form').addEventListener('submit', event => authenticate(event, '/api/auth/register', loginFields));
document.querySelector('#login-form').addEventListener('submit', event => authenticate(event, '/api/auth/login', loginFields));
document.querySelector('#bootstrap-form').addEventListener('submit', event => authenticate(event, '/api/auth/bootstrap', [...loginFields, ['setupToken', '#bootstrap-token']]));

document.querySelector('#logout-button').addEventListener('click', async () => {
  const button = document.querySelector('#logout-button');
  button.disabled = true;
  try {
    await api('/api/auth/logout', { method: 'POST' });
    accountStatus.textContent = 'Signed out.';
  } catch (error) {
    accountStatus.textContent = error.message;
  } finally {
    token = null;
    sessionStorage.removeItem('research-session');
    showMember(null);
    button.disabled = false;
  }
});

function displayItems(container, items, curator) {
  container.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = text(item.title, 'Untitled record');
    const meta = document.createElement('span');
    meta.textContent = `${label(item.kind, 'Research')} · ${text(item.primaryLanguage, '—')} · ${label(item.reviewStatus, 'Pending')}`;
    li.append(title, meta);
    if (curator) {
      const detail = document.createElement('div');
      detail.className = 'review-detail';
      const inspect = document.createElement('button');
      inspect.type = 'button';
      inspect.className = 'button-outline';
      inspect.textContent = 'Read before reviewing';
      inspect.addEventListener('click', async () => {
        inspect.disabled = true;
        try {
          const record = await api(`/api/curation/submissions/${encodeURIComponent(item.id)}`);
          detail.replaceChildren();
          for (const translation of record.translations) {
            const heading = document.createElement('h4');
            heading.textContent = `${translation.title} (${translation.language})`;
            const abstract = document.createElement('p');
            abstract.textContent = translation.abstract;
            detail.append(heading, abstract);
          }
          if (record.sourceUrl) {
            const source = document.createElement('p');
            source.textContent = `Source: ${record.sourceUrl}`;
            detail.append(source);
          }
          if (record.hasFile) {
            const pdf = document.createElement('button');
            pdf.className = 'button-outline';
            pdf.type = 'button';
            pdf.textContent = 'Open submitted PDF';
            pdf.addEventListener('click', async () => {
              try {
                const response = await fetch(`/api/me/submissions/${encodeURIComponent(item.id)}/file`, { headers: { authorization: `Bearer ${token}` } });
                if (!response.ok) throw new Error('PDF unavailable.');
                const objectUrl = URL.createObjectURL(await response.blob());
                const link = document.createElement('a');
                link.href = objectUrl;
                link.download = 'research.pdf';
                link.click();
                setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
              } catch (error) { curationStatus.textContent = error.message; }
            });
            detail.append(pdf);
          }
          for (const decision of ['approve', 'reject']) {
            const action = document.createElement('button');
            action.className = 'button-outline';
            action.type = 'button';
            action.textContent = decision === 'approve' ? 'Approve for public view' : 'Reject';
            action.addEventListener('click', async () => {
              action.disabled = true;
              try {
                await api(`/api/curation/submissions/${encodeURIComponent(item.id)}/${decision}`, { method: 'POST', body: {} });
                curationStatus.textContent = decision === 'approve' ? 'Approved for public discovery.' : 'Record rejected.';
                await refreshMember();
                if (decision === 'approve') {
                  records.length = 0;
                  nextOffset = 0;
                  hasMore = true;
                  loadPage();
                }
              } catch (error) {
                curationStatus.textContent = error.message;
                action.disabled = false;
              }
            });
            detail.append(action);
          }
        } catch (error) {
          curationStatus.textContent = error.message;
          inspect.disabled = false;
        }
      });
      li.append(inspect, detail);
    }
    container.append(li);
  }
}

async function refreshMember() {
  if (!currentUser) return;
  myStatus.textContent = 'Loading your deposits…';
  try {
    const data = await api('/api/me/submissions');
    displayItems(document.querySelector('#my-list'), data.items, false);
    myStatus.textContent = data.items.length ? '' : 'You have no deposits yet.';
  } catch (error) { myStatus.textContent = error.message; }
  if (currentUser?.role === 'curator') {
    curationStatus.textContent = 'Loading pending reviews…';
    try {
      const data = await api('/api/curation/submissions');
      displayItems(document.querySelector('#curation-list'), data.items, true);
      curationStatus.textContent = data.items.length ? '' : 'Nothing is awaiting review.';
    } catch (error) { curationStatus.textContent = error.message; }
  }
}

document.querySelector('#deposit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const file = form.querySelector('#deposit-file').files[0];
  if (file && (file.size > 10 * 1024 * 1024 || file.type !== 'application/pdf')) {
    accountStatus.textContent = 'Choose a PDF no larger than 10 MiB.';
    return;
  }
  button.disabled = true;
  accountStatus.textContent = 'Depositing privately…';
  try {
    const language = form.querySelector('#deposit-language').value.trim();
    const sourceUrl = form.querySelector('#deposit-source').value.trim();
    const body = {
      kind: form.querySelector('#deposit-kind').value,
      primaryLanguage: language,
      translations: [{ language, title: form.querySelector('#deposit-title').value.trim(), abstract: form.querySelector('#deposit-abstract').value.trim() }]
    };
    if (sourceUrl) body.sourceUrl = sourceUrl;
    const result = await api('/api/submissions', { method: 'POST', body });
    if (file) {
      try {
        await api(`/api/me/submissions/${encodeURIComponent(result.id)}/file`, { method: 'PUT', body: file });
      } catch (error) {
        accountStatus.textContent = `Metadata saved privately, but the PDF upload failed: ${error.message}`;
        await refreshMember();
        return;
      }
    }
    form.reset();
    accountStatus.textContent = 'Your deposit is private and awaiting independent curator review.';
    await refreshMember();
  } catch (error) { accountStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

if (token) {
  api('/api/auth/me').then(data => {
    showMember(data.user);
    refreshMember();
  }).catch(() => { token = null; sessionStorage.removeItem('research-session'); showMember(null); });
}
