/**
 * public/js/app.js — Bulk PDF Generator SPA
 *
 * Vanilla JS, no framework, no bundler required.
 * Organized into self-contained namespaces:
 *   Token  — access-token handling
 *   Api    — fetch wrapper
 *   Toast  — notification system
 *   Modal  — modal management
 *   View   — top-level view router
 *   Templates — template list view
 *   Editor — PDF viewer + field mapper
 *   Generator — batch generation workflow
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════
const state = {
  token:           null,
  templates:       [],
  editor: {
    template:      null,   // full template object with fields
    pdfDoc:        null,   // PDF.js PDFDocumentProxy
    currentPage:   1,
    totalPages:    1,
    scale:         1.5,
    pendingMapping:{},     // { pdfFieldName: csvColumnName } — staging
    activeField:   null,   // field currently highlighted in list
  },
  generator: {
    templateId:    null,
    batchId:       null,
    csvFile:       null,
    csvColumns:    [],
    status:        'idle', // idle | uploading | processing | done | error
    pollTimer:     null,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN
// ═══════════════════════════════════════════════════════════════════════════
const Token = {
  init() {
    // Read token from URL, cache it, then clean the URL
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token') || sessionStorage.getItem('pdf_gen_token') || '';
    if (t) {
      state.token = t;
      sessionStorage.setItem('pdf_gen_token', t);
      // Remove token from displayed URL
      params.delete('token');
      const newQ = params.toString();
      const newUrl = newQ ? `${location.pathname}?${newQ}` : location.pathname;
      history.replaceState({}, '', newUrl);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════════════
const Api = {
  headers(extra = {}) {
    const h = { ...extra };
    if (state.token) h['x-access-token'] = state.token;
    return h;
  },

  async fetch(path, opts = {}) {
    const isFormData = opts.body instanceof FormData;
    const options = {
      ...opts,
      headers: this.headers(isFormData ? {} : { 'Content-Type': 'application/json', ...(opts.headers || {}) }),
    };
    if (isFormData) delete options.headers['Content-Type'];

    const res = await fetch(path, options);

    // Attempt JSON parse; fall back to text
    let body;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }

    if (!res.ok) {
      const msg = (typeof body === 'object' && body.error) ? body.error : `HTTP ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status, body });
    }
    return body;
  },

  get:    (path) => Api.fetch(path),
  post:   (path, data) => Api.fetch(path, { method: 'POST', body: JSON.stringify(data) }),
  put:    (path, data) => Api.fetch(path, { method: 'PUT',  body: JSON.stringify(data) }),
  delete: (path)       => Api.fetch(path, { method: 'DELETE' }),
  upload: (path, form) => Api.fetch(path, { method: 'POST', body: form }),
};

// ═══════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════
const Toast = {
  container: null,

  init() { this.container = document.getElementById('toast-container'); },

  show(message, type = 'info', duration = 4000) {
    const icons = {
      success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
      error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `${icons[type] || icons.info}<p>${message}</p>`;
    this.container.append(el);

    setTimeout(() => {
      el.style.animation = 'toast-out .2s ease forwards';
      setTimeout(() => el.remove(), 200);
    }, duration);
  },

  success: (msg) => Toast.show(msg, 'success'),
  error:   (msg) => Toast.show(msg, 'error', 6000),
  info:    (msg) => Toast.show(msg, 'info'),
};

// ═══════════════════════════════════════════════════════════════════════════
// MODAL
// ═══════════════════════════════════════════════════════════════════════════
const Modal = {
  overlay: null,

  init() {
    this.overlay = document.getElementById('modal-overlay');

    // Close on overlay click
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.closeAll();
    });

    // Close buttons
    document.querySelectorAll('.modal-close, [data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.close || 'all';
        if (id === 'all') this.closeAll();
        else this.close(id);
      });
    });

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeAll();
    });
  },

  open(id) {
    this.overlay.classList.remove('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    const m = document.getElementById(id);
    if (m) m.classList.remove('hidden');
  },

  close(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('hidden');
    const anyOpen = [...document.querySelectorAll('.modal')].some(m => !m.classList.contains('hidden'));
    if (!anyOpen) this.overlay.classList.add('hidden');
  },

  closeAll() {
    this.overlay.classList.add('hidden');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  },

  confirm(title, message) {
    return new Promise(resolve => {
      document.getElementById('confirm-title').textContent   = title;
      document.getElementById('confirm-message').textContent = message;
      this.open('modal-confirm');
      const btn = document.getElementById('btn-confirm-action');
      const handler = () => { this.close('modal-confirm'); resolve(true); btn.removeEventListener('click', handler); };
      btn.addEventListener('click', handler);
    });
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// VIEW ROUTER
// ═══════════════════════════════════════════════════════════════════════════
const View = {
  current: 'templates',

  show(name, opts = {}) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const el = document.getElementById(`view-${name}`);
    if (el) el.classList.add('active');

    // Sidebar nav highlight
    document.querySelectorAll('.nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.view === name || (name === 'editor' && b.dataset.view === 'templates'));
    });

    // Topbar title
    const titles = { templates: 'Templates', editor: opts.title || 'Template Editor', generator: 'Batch Generator' };
    document.getElementById('page-title').textContent = titles[name] || name;

    // Back button
    const backBtn = document.getElementById('btn-back');
    backBtn.classList.toggle('hidden', name === 'templates' || name === 'generator');

    // Topbar actions
    document.getElementById('topbar-actions').innerHTML = '';

    this.current = name;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATES LISTING
// ═══════════════════════════════════════════════════════════════════════════
const Templates = {
  async load() {
    const grid = document.getElementById('template-grid');
    try {
      const { templates } = await Api.get('/api/templates');
      state.templates = templates;
      this.render(templates);
    } catch (err) {
      grid.innerHTML = `<div class="empty-state"><p>Failed to load templates: ${err.message}</p></div>`;
    }
  },

  render(templates) {
    const grid = document.getElementById('template-grid');
    if (!templates.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <p>No templates yet. Upload your first fillable PDF.</p>
        </div>`;
      return;
    }

    grid.innerHTML = templates.map(t => {
      const fieldCount  = (t.fields || []).length;
      const mappedCount = Object.keys(t.mapping || {}).filter(k => t.mapping[k]).length;
      const date = new Date(t.createdAt).toLocaleDateString();
      return `
        <div class="template-card" data-id="${t.id}">
          <div class="tc-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
          <div class="tc-name">${esc(t.name)}</div>
          <div class="tc-meta">
            <span>${fieldCount} field${fieldCount !== 1 ? 's' : ''}</span>
            <span>${mappedCount} mapped</span>
            <span>${date}</span>
          </div>
          <div class="tc-actions">
            <button class="btn btn-secondary btn-edit" data-id="${t.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Map Fields
            </button>
            <button class="btn btn-primary btn-gen" data-id="${t.id}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Generate
            </button>
            <button class="btn btn-ghost btn-delete" data-id="${t.id}" title="Delete template" style="flex:0;padding:8px 9px">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.btn-edit').forEach(b =>
      b.addEventListener('click', () => Editor.open(b.dataset.id)));
    grid.querySelectorAll('.btn-gen').forEach(b =>
      b.addEventListener('click', () => Generator.open(b.dataset.id)));
    grid.querySelectorAll('.btn-delete').forEach(b =>
      b.addEventListener('click', () => Templates.delete(b.dataset.id)));
  },

  async delete(id) {
    const t = state.templates.find(x => x.id === id);
    if (!t) return;
    const ok = await Modal.confirm('Delete Template', `Delete "${t.name}"? This cannot be undone.`);
    if (!ok) return;
    try {
      await Api.delete(`/api/templates/${id}`);
      Toast.success('Template deleted.');
      this.load();
    } catch (err) {
      Toast.error(`Delete failed: ${err.message}`);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// TEMPLATE UPLOAD
// ═══════════════════════════════════════════════════════════════════════════
const UploadTemplate = {
  pdfFile: null,

  init() {
    document.getElementById('btn-upload-template').addEventListener('click', () => this.openModal());

    // PDF drop zone
    const dz = document.getElementById('pdf-drop-zone');
    const fi = document.getElementById('pdf-file-input');
    dz.addEventListener('click', () => fi.click());
    fi.addEventListener('change', () => this.selectFile(fi.files[0]));
    setupDropZone(dz, (f) => this.selectFile(f));

    document.getElementById('btn-confirm-upload').addEventListener('click', () => this.submit());
  },

  openModal() {
    this.pdfFile = null;
    document.getElementById('upload-name').value = '';
    document.getElementById('pdf-selected-name').textContent = 'No file selected';
    document.getElementById('pdf-drop-zone').classList.remove('has-file');
    document.getElementById('btn-confirm-upload').disabled = true;
    Modal.open('modal-upload');
  },

  selectFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      Toast.error('Please select a .pdf file.');
      return;
    }
    this.pdfFile = file;
    document.getElementById('pdf-selected-name').textContent = file.name;
    document.getElementById('pdf-drop-zone').classList.add('has-file');
    if (!document.getElementById('upload-name').value) {
      document.getElementById('upload-name').value = file.name.replace(/\.pdf$/i, '');
    }
    document.getElementById('btn-confirm-upload').disabled = false;
  },

  async submit() {
    if (!this.pdfFile) return;
    const btn  = document.getElementById('btn-confirm-upload');
    const name = document.getElementById('upload-name').value.trim() || this.pdfFile.name.replace(/\.pdf$/i, '');
    btn.disabled = true;
    btn.innerHTML = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg> Uploading…';

    try {
      const form = new FormData();
      form.append('pdf',  this.pdfFile);
      form.append('name', name);
      const { template, fieldCount } = await Api.upload('/api/templates/upload', form);
      Modal.closeAll();
      Toast.success(`"${template.name}" uploaded — ${fieldCount} field${fieldCount !== 1 ? 's' : ''} detected.`);
      await Templates.load();
      // Auto-open the editor so the user can map fields right away
      Editor.open(template.id);
    } catch (err) {
      Toast.error(`Upload failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Upload & Detect Fields';
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// EDITOR — PDF viewer + field mapper
// ═══════════════════════════════════════════════════════════════════════════
const Editor = {
  fieldBeingMapped: null,  // { name, type, page, rect }

  async open(templateId) {
    View.show('editor', { title: 'Loading…' });
    document.getElementById('field-overlay').innerHTML = '';
    document.getElementById('fields-list').innerHTML =
      '<div class="loading-placeholder"><svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg> Loading fields…</div>';

    try {
      const template = await Api.get(`/api/templates/${templateId}`);
      state.editor.template = template;
      state.editor.pendingMapping = { ...(template.mapping || {}) };
      state.editor.currentPage   = 1;
      state.editor.scale         = 1.5;

      View.show('editor', { title: esc(template.name) });
      document.getElementById('page-title').textContent = esc(template.name);

      // Load PDF.js document
      const pdfUrl = `/api/templates/${templateId}/pdf` + (state.token ? `?token=${encodeURIComponent(state.token)}` : '');
      if (typeof pdfjsLib === 'undefined') {
        throw new Error('PDF.js failed to load. Please refresh the page.');
      }
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.js';

      const loadingTask = pdfjsLib.getDocument({ url: pdfUrl, withCredentials: false });
      state.editor.pdfDoc   = await loadingTask.promise;
      state.editor.totalPages = state.editor.pdfDoc.numPages;

      this.updatePageControls();
      await this.renderPage(1);
      this.renderFieldList();
    } catch (err) {
      Toast.error(`Failed to open editor: ${err.message}`);
      View.show('templates');
    }
  },

  async renderPage(pageNum) {
    const { pdfDoc, scale } = state.editor;
    const page     = await pdfDoc.getPage(pageNum);

    // Auto-fit to container width
    const wrapper    = document.getElementById('pdf-viewport-wrapper');
    const availW     = wrapper.clientWidth - 40;
    const viewport0  = page.getViewport({ scale: 1 });
    const fitScale   = Math.min(availW / viewport0.width, 2.5);
    const useScale   = fitScale;
    state.editor.scale = useScale;

    const viewport  = page.getViewport({ scale: useScale });
    const canvas    = document.getElementById('pdf-canvas');
    const ctx       = canvas.getContext('2d');

    canvas.width  = viewport.width;
    canvas.height = viewport.height;

    // Resize overlay to match canvas exactly
    const viewportEl   = document.getElementById('pdf-viewport');
    viewportEl.style.width  = `${viewport.width}px`;
    viewportEl.style.height = `${viewport.height}px`;

    await page.render({ canvasContext: ctx, viewport }).promise;

    state.editor.currentPage = pageNum;
    this.updatePageControls();
    this.renderOverlays();
    this.updateZoomDisplay();
  },

  renderOverlays() {
    const overlay  = document.getElementById('field-overlay');
    const fields   = (state.editor.template?.fields || []);
    const mapping  = state.editor.pendingMapping;
    const curPage  = state.editor.currentPage - 1; // 0-based
    const scale    = state.editor.scale;

    overlay.innerHTML = '';

    fields
      .filter(f => f.rect && f.page === curPage)
      .forEach(f => {
        const r    = f.rect;
        const div  = document.createElement('div');
        div.className = `field-hotspot ${mapping[f.name] ? 'mapped' : ''}`;
        div.style.left   = `${r.x * scale}px`;
        div.style.top    = `${r.y * scale}px`;
        div.style.width  = `${r.width  * scale}px`;
        div.style.height = `${r.height * scale}px`;
        div.title = mapping[f.name] ? `${f.name} → ${mapping[f.name]}` : f.name;

        const label = document.createElement('span');
        label.className = 'hotspot-label';
        label.textContent = mapping[f.name] || f.name;
        div.appendChild(label);

        div.addEventListener('click', () => this.openFieldModal(f));
        overlay.appendChild(div);
      });
  },

  renderFieldList() {
    const list    = document.getElementById('fields-list');
    const fields  = state.editor.template?.fields || [];
    const mapping = state.editor.pendingMapping;

    document.getElementById('field-count-badge').textContent =
      `${fields.length} field${fields.length !== 1 ? 's' : ''}`;

    this.renderFilteredFieldList(fields, mapping, '');

    // Search
    document.getElementById('field-search').addEventListener('input', (e) => {
      this.renderFilteredFieldList(fields, mapping, e.target.value.toLowerCase());
    });
  },

  renderFilteredFieldList(fields, mapping, filter) {
    const list   = document.getElementById('fields-list');
    const active = state.editor.activeField;
    const filtered = filter
      ? fields.filter(f => f.name.toLowerCase().includes(filter) || (mapping[f.name] || '').toLowerCase().includes(filter))
      : fields;

    if (!filtered.length) {
      list.innerHTML = '<div style="padding:16px;color:var(--text-4);font-size:13px">No fields match the search.</div>';
      return;
    }

    list.innerHTML = filtered.map(f => {
      const mappedTo = mapping[f.name] || '';
      return `
        <div class="field-item ${active === f.name ? 'active' : ''}" data-name="${esc(f.name)}">
          <span class="fi-dot ${mappedTo ? 'mapped' : 'unmapped'}"></span>
          <div class="fi-info">
            <div class="fi-label">${esc(f.name)}</div>
            <div class="fi-mapped ${mappedTo ? 'has-value' : ''}">${mappedTo ? `→ ${esc(mappedTo)}` : 'Not mapped'}</div>
          </div>
          <span class="fi-badge">${esc(f.type)}</span>
        </div>`;
    }).join('');

    list.querySelectorAll('.field-item').forEach(item => {
      item.addEventListener('click', () => {
        const field = fields.find(f => f.name === item.dataset.name);
        if (field) this.openFieldModal(field);
      });
    });
  },

  openFieldModal(field) {
    this.fieldBeingMapped = field;
    state.editor.activeField = field.name;

    // Highlight in list
    document.querySelectorAll('.field-item').forEach(el => {
      el.classList.toggle('active', el.dataset.name === field.name);
    });
    // Highlight on overlay
    document.querySelectorAll('.field-hotspot').forEach(el => {
      el.classList.toggle('selected', el.title.startsWith(field.name));
    });

    // Populate modal
    document.getElementById('fi-name').textContent = field.name;
    document.getElementById('fi-type').textContent = field.type;
    document.getElementById('fi-page').textContent = `Page ${field.page + 1}`;

    const colInput = document.getElementById('fi-csv-col');
    colInput.value = state.editor.pendingMapping[field.name] || '';

    // Navigate to the field's page if needed
    if (field.page + 1 !== state.editor.currentPage) {
      this.renderPage(field.page + 1);
    }

    // Show known CSV columns as chips (from last generator upload)
    const chips      = document.getElementById('csv-col-chips');
    const hint       = document.getElementById('csv-columns-hint');
    const csvCols    = state.generator.csvColumns;
    if (csvCols.length) {
      hint.classList.remove('hidden');
      chips.innerHTML = csvCols.map(c =>
        `<span class="col-chip" data-col="${esc(c)}">${esc(c)}</span>`
      ).join('');
      chips.querySelectorAll('.col-chip').forEach(ch => {
        ch.addEventListener('click', () => { colInput.value = ch.dataset.col; colInput.focus(); });
      });
    } else {
      hint.classList.add('hidden');
    }

    Modal.open('modal-field');
    colInput.focus();
  },

  initFieldModal() {
    document.getElementById('btn-confirm-field-mapping').addEventListener('click', () => {
      const field  = this.fieldBeingMapped;
      const colVal = document.getElementById('fi-csv-col').value.trim();
      if (!field) return;

      state.editor.pendingMapping[field.name] = colVal;
      this.renderOverlays();
      this.renderFieldList();
      Modal.close('modal-field');
      Toast.info(`"${field.name}" mapped to "${colVal || '(cleared)'}"`);
    });

    document.getElementById('btn-clear-field-mapping').addEventListener('click', () => {
      const field = this.fieldBeingMapped;
      if (!field) return;
      delete state.editor.pendingMapping[field.name];
      document.getElementById('fi-csv-col').value = '';
    });

    // Enter key submits
    document.getElementById('fi-csv-col').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-confirm-field-mapping').click();
    });
  },

  async saveMapping() {
    const { template, pendingMapping } = state.editor;
    if (!template) return;
    const btn = document.getElementById('btn-save-mapping');
    btn.disabled = true;
    btn.innerHTML = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg> Saving…';
    try {
      await Api.put(`/api/templates/${template.id}/mapping`, { mapping: pendingMapping });
      // Refresh local state
      const mappedCount = Object.values(pendingMapping).filter(Boolean).length;
      Toast.success(`Mappings saved (${mappedCount} field${mappedCount !== 1 ? 's' : ''} mapped).`);
      await Templates.load(); // refresh sidebar count
    } catch (err) {
      Toast.error(`Save failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Save Mappings';
    }
  },

  autoMap() {
    // Auto-map fields where the PDF field name exactly matches a likely CSV column
    const fields = state.editor.template?.fields || [];
    let count = 0;
    fields.forEach(f => {
      if (!state.editor.pendingMapping[f.name]) {
        state.editor.pendingMapping[f.name] = f.name; // identity mapping
        count++;
      }
    });
    this.renderOverlays();
    this.renderFieldList();
    Toast.info(`Auto-mapped ${count} field${count !== 1 ? 's' : ''} using identical names.`);
  },

  updatePageControls() {
    const { currentPage, totalPages } = state.editor;
    document.getElementById('page-indicator').textContent = `Page ${currentPage} / ${totalPages}`;
    document.getElementById('btn-prev-page').disabled = currentPage <= 1;
    document.getElementById('btn-next-page').disabled = currentPage >= totalPages;
  },

  updateZoomDisplay() {
    document.getElementById('zoom-level').textContent = `${Math.round(state.editor.scale * 100)}%`;
  },

  initControls() {
    document.getElementById('btn-prev-page').addEventListener('click', () => {
      if (state.editor.currentPage > 1) this.renderPage(state.editor.currentPage - 1);
    });
    document.getElementById('btn-next-page').addEventListener('click', () => {
      if (state.editor.currentPage < state.editor.totalPages) this.renderPage(state.editor.currentPage + 1);
    });
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      state.editor.scale = Math.min(state.editor.scale + 0.25, 3);
      if (state.editor.pdfDoc) this.renderPage(state.editor.currentPage);
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      state.editor.scale = Math.max(state.editor.scale - 0.25, 0.5);
      if (state.editor.pdfDoc) this.renderPage(state.editor.currentPage);
    });
    document.getElementById('btn-save-mapping').addEventListener('click', () => this.saveMapping());
    document.getElementById('btn-auto-map').addEventListener('click', () => this.autoMap());
    document.getElementById('btn-back').addEventListener('click', () => View.show('templates'));
    this.initFieldModal();
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// GENERATOR — batch generation workflow
// ═══════════════════════════════════════════════════════════════════════════
const Generator = {
  open(templateId) {
    // Reset state
    state.generator.batchId   = null;
    state.generator.csvFile   = null;
    state.generator.status    = 'idle';
    clearInterval(state.generator.pollTimer);

    View.show('generator');

    // Populate template dropdown
    const sel = document.getElementById('gen-template-select');
    sel.innerHTML = '<option value="">— Choose a template —</option>' +
      state.templates.map(t =>
        `<option value="${t.id}" ${t.id === templateId ? 'selected' : ''}>${esc(t.name)}</option>`
      ).join('');

    this.resetUI();
    if (templateId) this.onTemplateChange(templateId);
  },

  resetUI() {
    // CSV section
    document.getElementById('csv-info').classList.add('hidden');
    document.getElementById('csv-drop-zone').classList.remove('hidden', 'has-file');
    document.getElementById('csv-file-input').value = '';
    state.generator.csvFile = null;

    // Generator section
    document.getElementById('btn-generate').disabled = true;
    document.getElementById('progress-block').classList.add('hidden');
    document.getElementById('gen-summary').classList.add('hidden');
    document.getElementById('btn-download').classList.add('hidden');
    document.getElementById('error-list').classList.add('hidden');
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('progress-text').textContent = 'Preparing…';
    document.getElementById('progress-pct').textContent  = '0%';
  },

  onTemplateChange(templateId) {
    const template = state.templates.find(t => t.id === templateId);
    const card     = document.getElementById('template-preview-card');

    if (template) {
      card.classList.remove('hidden');
      document.getElementById('tpc-name').textContent   = template.name;
      const mapped = Object.keys(template.mapping || {}).filter(k => template.mapping[k]).length;
      document.getElementById('tpc-fields').textContent = `${mapped} field${mapped !== 1 ? 's' : ''} mapped`;
      this.renderMappingPreview(template);
    } else {
      card.classList.add('hidden');
      document.getElementById('mapping-preview').innerHTML = '<p class="placeholder-text">Select a template with saved mappings to preview.</p>';
    }
    this.updateGenerateBtn();
  },

  renderMappingPreview(template) {
    const preview = document.getElementById('mapping-preview');
    const mapping = template.mapping || {};
    const fields  = template.fields  || [];

    if (!fields.length) {
      preview.innerHTML = '<p class="placeholder-text">This template has no detected AcroForm fields.</p>';
      return;
    }

    const rows = fields.map(f => {
      const csvCol = mapping[f.name] || '';
      return `<tr>
        <td>${esc(f.name)}</td>
        <td class="fi-badge">${esc(f.type)}</td>
        <td class="${csvCol ? 'mapped-col' : 'unmapped'}">${csvCol ? esc(csvCol) : '—'}</td>
      </tr>`;
    }).join('');

    preview.innerHTML = `
      <table class="mapping-table">
        <thead><tr><th>PDF Field</th><th>Type</th><th>CSV Column</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  },

  onCsvSelected(file) {
    if (!file || !file.name.toLowerCase().endsWith('.csv')) {
      Toast.error('Please select a .csv file.');
      return;
    }
    state.generator.csvFile = file;
    document.getElementById('csv-drop-zone').classList.add('hidden');
    document.getElementById('csv-info').classList.remove('hidden');
    document.getElementById('csv-info-text').textContent = `${file.name} (${formatBytes(file.size)})`;
    this.updateGenerateBtn();
  },

  clearCsv() {
    state.generator.csvFile = null;
    document.getElementById('csv-info').classList.add('hidden');
    document.getElementById('csv-drop-zone').classList.remove('hidden', 'has-file');
    document.getElementById('csv-file-input').value = '';
    this.updateGenerateBtn();
  },

  updateGenerateBtn() {
    const sel      = document.getElementById('gen-template-select');
    const hasTemplate = !!sel.value;
    const hasCsv      = !!state.generator.csvFile;
    const running     = ['uploading', 'processing'].includes(state.generator.status);
    document.getElementById('btn-generate').disabled = !hasTemplate || !hasCsv || running;
  },

  async run() {
    const sel      = document.getElementById('gen-template-select');
    const templateId = sel.value;
    const template   = state.templates.find(t => t.id === templateId);
    if (!template || !state.generator.csvFile) return;

    const mapping = template.mapping || {};
    if (!Object.keys(mapping).length) {
      Toast.error('This template has no field mappings. Open the editor and map fields first.');
      return;
    }

    state.generator.status   = 'uploading';
    state.generator.batchId  = null;
    this.updateGenerateBtn();

    // Show progress
    document.getElementById('progress-block').classList.remove('hidden');
    document.getElementById('gen-summary').classList.add('hidden');
    document.getElementById('btn-download').classList.add('hidden');
    document.getElementById('error-list').classList.add('hidden');
    document.getElementById('progress-text').textContent = 'Uploading CSV…';
    document.getElementById('btn-generate').innerHTML =
      '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg> Processing…';

    try {
      // Step 1: Upload CSV
      const form = new FormData();
      form.append('csv', state.generator.csvFile);
      const uploadRes = await Api.upload('/api/upload', form);
      const batchId   = uploadRes.batchId;
      state.generator.batchId  = batchId;
      state.generator.csvColumns = uploadRes.columns || [];
      document.getElementById('csv-info-text').textContent =
        `${state.generator.csvFile.name} — ${uploadRes.rowCount} rows detected`;

      document.getElementById('progress-text').textContent = 'Generating PDFs…';
      state.generator.status = 'processing';

      // Step 2: Trigger generation
      await Api.post('/api/generate', { batchId, fieldMapping: mapping });

      // Done
      this.handleComplete(batchId);
    } catch (err) {
      state.generator.status = 'error';
      document.getElementById('progress-text').textContent = 'Failed.';
      Toast.error(`Generation failed: ${err.message}`);
      this.resetGenerateButton();
      this.updateGenerateBtn();
    }
  },

  async handleComplete(batchId) {
    // Fetch final summary
    let summary = {};
    try {
      const prog = await Api.get(`/api/progress/${batchId}`);
      summary = prog.summary || {};
    } catch {}

    state.generator.status = 'done';
    document.getElementById('progress-bar').style.width = '100%';
    document.getElementById('progress-text').textContent = 'Complete!';
    document.getElementById('progress-pct').textContent  = '100%';

    // Stats
    document.getElementById('sum-total').textContent   = summary.total   || '?';
    document.getElementById('sum-success').textContent = summary.success || '?';
    document.getElementById('sum-failed').textContent  = summary.failed  || 0;
    document.getElementById('gen-summary').classList.remove('hidden');
    document.getElementById('btn-download').classList.remove('hidden');

    // Errors
    if (summary.errors && summary.errors.length) {
      document.getElementById('error-list').classList.remove('hidden');
      document.getElementById('error-items').innerHTML = summary.errors.map(e =>
        `<li>Row ${e.row}: ${esc(e.message)}</li>`
      ).join('');
    }

    Toast.success(`Generated ${summary.success || 0} PDF${summary.success !== 1 ? 's' : ''}.`);
    this.resetGenerateButton();
    this.updateGenerateBtn();
  },

  download() {
    const { batchId } = state.generator;
    if (!batchId) return;
    const token = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
    window.location.href = `/api/download/${batchId}${token}`;
  },

  resetGenerateButton() {
    document.getElementById('btn-generate').innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Generate PDFs';
  },

  init() {
    // Template selector change
    document.getElementById('gen-template-select').addEventListener('change', (e) => {
      this.onTemplateChange(e.target.value);
    });

    // Edit mapping shortcut
    document.getElementById('btn-tpc-edit').addEventListener('click', () => {
      const id = document.getElementById('gen-template-select').value;
      if (id) Editor.open(id);
    });

    // CSV drop zone
    const dz  = document.getElementById('csv-drop-zone');
    const fi  = document.getElementById('csv-file-input');
    dz.addEventListener('click', () => fi.click());
    fi.addEventListener('change', () => this.onCsvSelected(fi.files[0]));
    setupDropZone(dz, (f) => this.onCsvSelected(f));

    document.getElementById('btn-csv-clear').addEventListener('click', () => this.clearCsv());
    document.getElementById('btn-generate').addEventListener('click', () => this.run());
    document.getElementById('btn-download').addEventListener('click', () => this.download());
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setupDropZone(dropEl, onFile) {
  dropEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropEl.classList.add('drag-over');
  });
  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag-over'));
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  Token.init();
  Toast.init();
  Modal.init();
  Editor.initControls();
  Generator.init();
  UploadTemplate.init();

  // Sidebar navigation
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      if (v === 'generator') {
        Generator.open(null);
      } else {
        View.show(v);
      }
    });
  });

  // Load initial data
  await Templates.load();
  View.show('templates');
});
