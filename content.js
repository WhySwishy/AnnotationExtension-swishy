(() => {
    const HOSTNAME = window.location.hostname;
    let placementMode = false;
    let placementCallback = null;

    // NoteManager class to handle multiple notes
    class NoteManager {
        constructor() {
            this.notesMap = new Map(); // Map<noteId, {overlay, shadowRoot, observer, targetElement}>
            this.rafPending = false;
            this.mutationObserver = null;
            this.pendingNoteStyle = null;
            this.storageMutationQueue = [];
            this.isProcessingStorageMutation = false;
            this.init();
        }

        init() {
            // Load notes and migrate if needed
            chrome.storage.local.get([HOSTNAME], (result) => {
                const data = result[HOSTNAME];
                if (!data) return;

                // Migration: Convert old single-note format to new array format
                if (data.text !== undefined && !data.notes) {
                    this.migrateOldFormat(data);
                    return;
                }

                if (data.notes && Array.isArray(data.notes)) {
                    data.notes.forEach(note => {
                        if (note.visible !== false) {
                            this.createNoteOverlay(note);
                        }
                    });
                }
            });

            this.setupMutationObserver();
            this.setupScrollListener();

            // Listen for storage changes
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local' && changes[HOSTNAME]) {
                    this.handleStorageChange(changes[HOSTNAME]);
                }
            });

            // Listen for messages from popup
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                if (message.action === 'startPlacement') {
                    this.pendingNoteStyle = message.style; // Store style for when note is created
                    this.startPlacementMode(sendResponse);
                    return true; // Keep channel open for async response
                } else if (message.action === 'cancelPlacement') {
                    this.cancelPlacementMode();
                    this.pendingNoteStyle = null;
                } else if (message.action === 'createNoteAtPosition') {
                    this.createNoteAtPosition(message.x, message.y, message.noteData);
                } else if (message.action === 'deleteNote') {
                    this.deleteNote(message.noteId);
                } else if (message.action === 'updateNote') {
                    this.updateNote(message.noteId, message.noteData);
                }
            });

            // Handle page clicks for placement mode
            document.addEventListener('click', this.handlePlacementClick.bind(this), true);
        }

        migrateOldFormat(oldData) {
            if (!oldData.text || oldData.text.trim().length === 0) return;

            const note = {
                id: this.generateNoteId(),
                text: oldData.text || '',
                anchor: oldData.position ? {
                    selector: 'body',
                    offset: { x: 0, y: 0 },
                    fallback: oldData.position
                } : {
                    selector: 'body',
                    offset: { x: 20, y: 20 }
                },
                style: oldData.style || { bg: '#1e1e2e', text: '#cdd6f4', opacity: 0.4, border: 'rgba(255,255,255,0.1)' },
                visible: oldData.visible !== false,
                minimized: oldData.minimized || false,
                size: oldData.size || { width: '300px', height: 'auto' }
            };

            const newData = { notes: [note] };
            chrome.storage.local.set({ [HOSTNAME]: newData }, () => {
                this.createNoteOverlay(note);
            });
        }

        generateNoteId() {
            return 'note-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        }

        mergeNoteData(baseNote = {}, patchNote = {}) {
            const merged = { ...baseNote, ...patchNote };

            if (baseNote.anchor || patchNote.anchor) {
                merged.anchor = { ...(baseNote.anchor || {}), ...(patchNote.anchor || {}) };
                if ((baseNote.anchor && baseNote.anchor.offset) || (patchNote.anchor && patchNote.anchor.offset)) {
                    merged.anchor.offset = {
                        ...((baseNote.anchor && baseNote.anchor.offset) || {}),
                        ...((patchNote.anchor && patchNote.anchor.offset) || {})
                    };
                }
            }

            if (baseNote.style || patchNote.style) {
                merged.style = { ...(baseNote.style || {}), ...(patchNote.style || {}) };
            }

            if (baseNote.size || patchNote.size) {
                merged.size = { ...(baseNote.size || {}), ...(patchNote.size || {}) };
            }

            return merged;
        }

        normalizeNoteData(noteData = {}) {
            const defaults = {
                id: this.generateNoteId(),
                text: '',
                anchor: {
                    selector: 'body',
                    offset: { x: 20, y: 20 }
                },
                style: { bg: '#fff740', text: '#202124', opacity: 0.95, border: 'rgba(0,0,0,0.1)' },
                visible: true,
                minimized: false,
                size: { width: '300px', height: 'auto' }
            };
            return this.mergeNoteData(defaults, noteData);
        }

        queueStorageMutation(mutator) {
            this.storageMutationQueue.push(mutator);
            if (this.isProcessingStorageMutation) {
                return;
            }
            this.isProcessingStorageMutation = true;
            this.processStorageMutationQueue();
        }

        processStorageMutationQueue() {
            if (this.storageMutationQueue.length === 0) {
                this.isProcessingStorageMutation = false;
                return;
            }

            const mutate = this.storageMutationQueue.shift();
            chrome.storage.local.get([HOSTNAME], (result) => {
                const storageData = result[HOSTNAME] || {};
                const nextData = {
                    ...storageData,
                    notes: Array.isArray(storageData.notes) ? [...storageData.notes] : []
                };

                mutate(nextData);

                chrome.storage.local.set({ [HOSTNAME]: nextData }, () => {
                    this.processStorageMutationQueue();
                });
            });
        }

        generateSelector(element) {
            if (!element || element === document.body) {
                return 'body';
            }

            // Try ID first
            if (element.id) {
                const idSelector = `#${CSS.escape(element.id)}`;
                if (document.querySelectorAll(idSelector).length === 1) {
                    return idSelector;
                }
            }

            // Try class combination
            if (element.className && typeof element.className === 'string') {
                const classes = element.className.trim().split(/\s+/).filter(c => c);
                if (classes.length > 0) {
                    const classSelector = element.tagName.toLowerCase() + '.' + classes.map(c => CSS.escape(c)).join('.');
                    const matches = document.querySelectorAll(classSelector);
                    if (matches.length === 1) {
                        return classSelector;
                    }
                }
            }

            // Fallback to path
            const path = [];
            let current = element;
            while (current && current !== document.body && path.length < 10) {
                let selector = current.tagName.toLowerCase();
                if (current.id) {
                    selector += `#${CSS.escape(current.id)}`;
                    path.unshift(selector);
                    break;
                }
                if (current.className && typeof current.className === 'string') {
                    const classes = current.className.trim().split(/\s+/).filter(c => c);
                    if (classes.length > 0) {
                        selector += '.' + CSS.escape(classes[0]);
                    }
                }
                const siblings = Array.from(current.parentElement?.children || []);
                const index = siblings.indexOf(current);
                if (index > 0) {
                    selector += `:nth-child(${index + 1})`;
                }
                path.unshift(selector);
                current = current.parentElement;
            }
            return path.join(' > ') || 'body';
        }

        findNearestSignificantElement(x, y) {
            const element = document.elementFromPoint(x, y);
            if (!element) return document.body;

            // Walk up the DOM tree to find a significant element
            let current = element;
            let depth = 0;
            const maxDepth = 10;

            while (current && current !== document.body && depth < maxDepth) {
                // Prefer elements with IDs, classes, or semantic tags
                if (current.id ||
                    (current.className && typeof current.className === 'string' && current.className.trim()) ||
                    ['article', 'section', 'main', 'header', 'footer', 'aside', 'nav', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(current.tagName.toLowerCase())) {
                    return current;
                }
                current = current.parentElement;
                depth++;
            }

            return current || document.body;
        }

        startPlacementMode(callback) {
            placementMode = true;
            placementCallback = callback;
            document.body.style.cursor = 'crosshair';

            if (callback) {
                callback({ success: true });
            }
        }

        cancelPlacementMode() {
            placementMode = false;
            placementCallback = null;
            document.body.style.cursor = '';
            this.pendingNoteStyle = null;
        }

        handlePlacementClick(e) {
            if (!placementMode) return;

            // Don't create note if clicking on an existing note overlay
            const clickedElement = e.target;
            if (clickedElement.closest && clickedElement.closest('.note-overlay-host, .annotation-fab-host')) {
                return;
            }
            if (clickedElement.shadowRoot || clickedElement.getRootNode().host) {
                const host = clickedElement.getRootNode().host;
                if (host && host.classList && (host.classList.contains('note-overlay-host') || host.classList.contains('annotation-fab-host'))) {
                    return;
                }
            }

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const x = e.clientX;
            const y = e.clientY;

            // Create note directly here with stored style
            if (this.pendingNoteStyle) {
                const noteId = this.generateNoteId();
                const noteData = this.normalizeNoteData({
                    id: noteId,
                    style: this.pendingNoteStyle
                });

                this.createNoteAtPosition(x, y, noteData);

                // Notify popup that note was created
                chrome.runtime.sendMessage({
                    action: 'noteCreated',
                    noteId: noteId
                });
            }

            this.cancelPlacementMode();
            this.pendingNoteStyle = null;
        }

        createNoteAtPosition(x, y, noteData) {
            const targetElement = this.findNearestSignificantElement(x, y);
            const targetRect = targetElement.getBoundingClientRect();

            // Calculate offset relative to target element
            const offset = {
                x: x - targetRect.left,
                y: y - targetRect.top
            };

            const selector = this.generateSelector(targetElement);
            const note = this.normalizeNoteData({
                ...noteData,
                anchor: {
                    selector: selector,
                    offset: offset
                }
            });

            this.createNoteOverlay(note);
            this.saveNote(note);
        }

        createNoteOverlay(noteData) {
            const normalizedNote = this.normalizeNoteData(noteData);

            if (this.notesMap.has(normalizedNote.id)) {
                this.updateNoteOverlay(normalizedNote);
                return;
            }

            // Create host container
            const overlayContainer = document.createElement('div');
            overlayContainer.id = `note-overlay-${normalizedNote.id}`;
            overlayContainer.className = 'note-overlay-host';

            // Shadow DOM for isolation
            const shadowRoot = overlayContainer.attachShadow({ mode: 'open' });

            // Inject styles
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = chrome.runtime.getURL('content.css');
            shadowRoot.appendChild(link);

            // Create wrapper
            const wrapper = document.createElement('div');
            wrapper.className = `note-overlay ${normalizedNote.minimized ? 'minimized' : ''}`;
            wrapper.dataset.noteId = normalizedNote.id;

            // Construct HTML
            wrapper.innerHTML = `
                <div class="note-header">
                    <span class="drag-handle-icon">⋮⋮</span>
                    <div class="controls">
                        <button class="control-btn minimize-btn" title="${normalizedNote.minimized ? 'Expand' : 'Minimize'}">
                            ${normalizedNote.minimized ? '□' : '_'}
                        </button>
                        <button class="control-btn delete-btn" title="Delete">×</button>
                    </div>
                </div>
                <div class="note-content-wrapper">
                    <div class="note-content" title="Double-click to edit"></div>
                </div>
            `;

            // Apply styles and position
            this.applyNoteStyles(wrapper, normalizedNote);
            this.updateNotePosition(wrapper, normalizedNote);

            shadowRoot.appendChild(wrapper);
            document.body.appendChild(overlayContainer);

            // Bind events
            this.bindNoteEvents(wrapper, normalizedNote.id);

            // Render content
            this.renderNoteContent(wrapper.querySelector('.note-content'), normalizedNote.text);

            // Setup intersection observer
            const targetElement = this.findTargetElement(normalizedNote.anchor);
            const observer = targetElement ? this.setupIntersectionObserver(normalizedNote.id, targetElement, wrapper) : null;
            this.notesMap.set(normalizedNote.id, {
                overlay: overlayContainer,
                shadowRoot: shadowRoot,
                wrapper: wrapper,
                observer: observer,
                targetElement: targetElement,
                noteData: normalizedNote
            });
        }

        findTargetElement(anchor) {
            try {
                const element = document.querySelector(anchor.selector);
                return element || null;
            } catch (e) {
                console.warn('Invalid selector:', anchor.selector);
                return null;
            }
        }

        calculateNotePosition(anchor) {
            const element = this.findTargetElement(anchor);
            if (!element) {
                // Fallback to stored absolute position if available
                if (anchor.fallback) {
                    return {
                        left: anchor.fallback.left || anchor.fallback.right || '20px',
                        top: anchor.fallback.top || '20px',
                        position: 'fixed'
                    };
                }
                return null;
            }

            const rect = element.getBoundingClientRect();
            // For fixed positioning, use viewport coordinates (no scroll offset needed)
            return {
                left: (rect.left + anchor.offset.x) + 'px',
                top: (rect.top + anchor.offset.y) + 'px',
                position: 'fixed'
            };
        }

        updateNotePosition(wrapper, noteData) {
            const position = this.calculateNotePosition(noteData.anchor);
            if (!position) {
                wrapper.style.display = 'none';
                return;
            }

            wrapper.style.position = position.position || 'fixed';
            wrapper.style.left = position.left;
            wrapper.style.top = position.top;
            wrapper.style.right = 'auto';
            wrapper.style.bottom = 'auto';
            wrapper.style.display = 'flex';
        }

        updateNotePositions() {
            if (this.rafPending) return;
            this.rafPending = true;

            requestAnimationFrame(() => {
                this.notesMap.forEach((noteInfo, noteId) => {
                    this.updateNotePosition(noteInfo.wrapper, noteInfo.noteData);
                });
                this.rafPending = false;
            });
        }

        setupIntersectionObserver(noteId, targetElement, wrapper) {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) {
                        wrapper.style.opacity = '0';
                        wrapper.style.pointerEvents = 'none';
                    } else {
                        wrapper.style.opacity = '1';
                        wrapper.style.pointerEvents = 'auto';
                    }
                });
            }, {
                threshold: 0,
                rootMargin: '50px' // Show note slightly before element enters viewport
            });

            observer.observe(targetElement);
            return observer;
        }

        setupScrollListener() {
            let ticking = false;
            const update = () => {
                this.updateNotePositions();
                ticking = false;
            };

            window.addEventListener('scroll', () => {
                if (!ticking) {
                    requestAnimationFrame(update);
                    ticking = true;
                }
            }, { passive: true });

            window.addEventListener('resize', () => {
                if (!ticking) {
                    requestAnimationFrame(update);
                    ticking = true;
                }
            }, { passive: true });
        }

        setupMutationObserver() {
            this.mutationObserver = new MutationObserver(() => {
                // Re-evaluate target elements and reposition notes
                this.notesMap.forEach((noteInfo, noteId) => {
                    const newTarget = this.findTargetElement(noteInfo.noteData.anchor);
                    if (newTarget && newTarget !== noteInfo.targetElement) {
                        // Target element changed, update observer
                        if (noteInfo.observer) {
                            noteInfo.observer.disconnect();
                        }
                        const observer = this.setupIntersectionObserver(noteId, newTarget, noteInfo.wrapper);
                        noteInfo.observer = observer;
                        noteInfo.targetElement = newTarget;
                    }
                    this.updateNotePosition(noteInfo.wrapper, noteInfo.noteData);
                });
            });

            this.mutationObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'id']
            });
        }

        applyNoteStyles(wrapper, noteData) {
            if (noteData.style) {
                const { bg, text, opacity, border } = noteData.style;
                const rgbaBg = this.hexToRgba(bg, opacity || 0.4);
                const solidBg = this.hexToRgba(bg, 1.0);

                wrapper.style.setProperty('--note-bg', rgbaBg);
                wrapper.style.setProperty('--note-bg-hover', solidBg);
                wrapper.style.setProperty('--note-text', text);
                wrapper.style.setProperty('--note-border', border || 'transparent');
                wrapper.style.setProperty('--header-bg', 'rgba(127, 127, 127, 0.1)');
            }

            if (!noteData.minimized) {
                wrapper.style.width = noteData.size?.width || '300px';
                wrapper.style.height = noteData.size?.height || 'auto';
            } else {
                wrapper.style.width = 'auto';
                wrapper.style.height = 'auto';
            }
        }

        renderNoteContent(container, text) {
            if (!container) return;
            const linkedText = this.linkify(text || '');
            container.innerHTML = linkedText;
        }

        linkify(text) {
            if (!text) return '';
            const urlRegex = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
            return this.escapeHtml(text).replace(urlRegex, (url) => {
                return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
            }).replace(/\n/g, '<br>');
        }

        bindNoteEvents(wrapper, noteId) {
            const header = wrapper.querySelector('.note-header');
            const minBtn = wrapper.querySelector('.minimize-btn');
            const deleteBtn = wrapper.querySelector('.delete-btn');
            const contentDiv = wrapper.querySelector('.note-content');

            // Drag
            header.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'BUTTON') return;
                this.startDrag(e, wrapper, noteId);
            });

            // Minimize
            minBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleMinimize(noteId);
            });

            // Delete
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('Delete this note?')) {
                    this.deleteNote(noteId);
                }
            });

            // Resize
            wrapper.addEventListener('mouseup', () => {
                const noteInfo = this.notesMap.get(noteId);
                if (noteInfo && !noteInfo.noteData.minimized) {
                    const newWidth = wrapper.style.width;
                    const newHeight = wrapper.style.height;
                    if (newWidth && newHeight) {
                        noteInfo.noteData.size = { width: newWidth, height: newHeight };
                        this.saveNote(noteInfo.noteData);
                    }
                }
            });

            // Edit
            contentDiv.addEventListener('dblclick', () => {
                const textarea = document.createElement('textarea');
                textarea.className = 'edit-textarea';
                const noteInfo = this.notesMap.get(noteId);
                textarea.value = noteInfo?.noteData.text || '';

                contentDiv.innerHTML = '';
                contentDiv.appendChild(textarea);
                textarea.focus();

                textarea.addEventListener('blur', () => {
                    const noteInfo = this.notesMap.get(noteId);
                    if (noteInfo) {
                        noteInfo.noteData.text = textarea.value;
                        this.saveNote(noteInfo.noteData);
                        this.renderNoteContent(contentDiv, textarea.value);
                    }
                });

                textarea.addEventListener('mousedown', e => e.stopPropagation());
                textarea.addEventListener('dblclick', e => e.stopPropagation());
            });
        }

        startDrag(e, wrapper, noteId) {
            let startX = e.clientX;
            let startY = e.clientY;
            const rect = wrapper.getBoundingClientRect();

            wrapper.style.right = 'auto';
            wrapper.style.bottom = 'auto';
            wrapper.style.left = rect.left + 'px';
            wrapper.style.top = rect.top + 'px';

            const noteInfo = this.notesMap.get(noteId);
            if (!noteInfo) return;

            const targetElement = noteInfo.targetElement || document.body;
            const targetRect = targetElement.getBoundingClientRect();

            function onMouseMove(e) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;

                const currentLeft = parseFloat(wrapper.style.left);
                const currentTop = parseFloat(wrapper.style.top);

                wrapper.style.left = (currentLeft + dx) + 'px';
                wrapper.style.top = (currentTop + dy) + 'px';

                startX = e.clientX;
                startY = e.clientY;
            }

            const self = this;
            function onMouseUp() {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);

                // Calculate new offset relative to target
                const wrapperRect = wrapper.getBoundingClientRect();
                const targetRect = targetElement.getBoundingClientRect();
                const newOffset = {
                    x: wrapperRect.left - targetRect.left,
                    y: wrapperRect.top - targetRect.top
                };

                noteInfo.noteData.anchor.offset = newOffset;
                self.saveNote(noteInfo.noteData);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        }

        toggleMinimize(noteId) {
            const noteInfo = this.notesMap.get(noteId);
            if (!noteInfo) return;

            noteInfo.noteData.minimized = !noteInfo.noteData.minimized;
            const wrapper = noteInfo.wrapper;

            if (noteInfo.noteData.minimized) {
                wrapper.classList.add('minimized');
                wrapper.querySelector('.minimize-btn').textContent = '□';
                wrapper.querySelector('.minimize-btn').title = 'Expand';
            } else {
                wrapper.classList.remove('minimized');
                wrapper.querySelector('.minimize-btn').textContent = '_';
                wrapper.querySelector('.minimize-btn').title = 'Minimize';
            }

            this.applyNoteStyles(wrapper, noteInfo.noteData);
            this.saveNote(noteInfo.noteData);
        }

        updateNoteOverlay(noteData) {
            const noteInfo = this.notesMap.get(noteData.id);
            if (!noteInfo) return;

            noteInfo.noteData = this.normalizeNoteData(this.mergeNoteData(noteInfo.noteData, noteData));
            noteInfo.overlay.style.display = noteInfo.noteData.visible === false ? 'none' : '';

            if (noteInfo.noteData.visible === false) {
                return;
            }

            this.applyNoteStyles(noteInfo.wrapper, noteInfo.noteData);
            this.updateNotePosition(noteInfo.wrapper, noteInfo.noteData);
            this.renderNoteContent(noteInfo.wrapper.querySelector('.note-content'), noteInfo.noteData.text);
        }

        updateNote(noteId, noteData) {
            const noteInfo = this.notesMap.get(noteId);
            if (!noteInfo) {
                this.saveNote({ id: noteId, ...noteData });
                return;
            }

            this.updateNoteOverlay({ id: noteId, ...noteData });
            this.saveNote(noteInfo.noteData);
        }

        removeNoteOverlay(noteId) {
            const noteInfo = this.notesMap.get(noteId);
            if (!noteInfo) return;

            if (noteInfo.observer) {
                noteInfo.observer.disconnect();
            }
            noteInfo.overlay.remove();
            this.notesMap.delete(noteId);
        }

        deleteNote(noteId) {
            this.removeNoteOverlay(noteId);
            this.queueStorageMutation((data) => {
                data.notes = data.notes.filter(n => n.id !== noteId);
            });
        }

        saveNote(noteData) {
            if (!noteData || !noteData.id) return;

            this.queueStorageMutation((data) => {
                const index = data.notes.findIndex(n => n.id === noteData.id);
                if (index >= 0) {
                    data.notes[index] = this.normalizeNoteData(this.mergeNoteData(data.notes[index], noteData));
                } else {
                    data.notes.push(this.normalizeNoteData(noteData));
                }
            });
        }

        handleStorageChange(change) {
            const newData = change.newValue;
            if (!newData || !Array.isArray(newData.notes)) {
                // Remove all notes
                this.notesMap.forEach((noteInfo) => {
                    if (noteInfo.observer) noteInfo.observer.disconnect();
                    noteInfo.overlay.remove();
                });
                this.notesMap.clear();
                return;
            }

            // Sync notes
            const currentIds = new Set(this.notesMap.keys());
            const visibleNotes = newData.notes
                .map(note => this.normalizeNoteData(note))
                .filter(note => note.visible !== false);
            const newIds = new Set(visibleNotes.map(n => n.id));

            // Remove deleted notes
            currentIds.forEach(id => {
                if (!newIds.has(id)) {
                    this.removeNoteOverlay(id);
                }
            });

            // Update/create notes
            visibleNotes.forEach(note => {
                if (this.notesMap.has(note.id)) {
                    this.updateNoteOverlay(note);
                } else {
                    this.createNoteOverlay(note);
                }
            });
        }

        escapeHtml(text) {
            if (!text) return '';
            return text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        hexToRgba(hex, alpha) {
            let r = 0, g = 0, b = 0;
            if (hex.length === 4) {
                r = parseInt(hex[1] + hex[1], 16);
                g = parseInt(hex[2] + hex[2], 16);
                b = parseInt(hex[3] + hex[3], 16);
            } else if (hex.length === 7) {
                r = parseInt(hex[1] + hex[2], 16);
                g = parseInt(hex[3] + hex[4], 16);
                b = parseInt(hex[5] + hex[6], 16);
            }
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
    }

    // HighlightManager class
    class HighlightManager {
        constructor() {
            this.highlightsMap = new Map(); // Map<highlightId, {element, type, data}>
            this.currentHighlightColor = '#fff740'; // Default yellow
            this.areaDrawingMode = false;
            this.areaStartPos = null;
            this.areaPreview = null;
            this.highlightModeActive = false;
            this.handleMouseUp = this.handleMouseUp.bind(this);
            this.init();
        }

        init() {
            chrome.storage.local.get([HOSTNAME], (result) => {
                const data = result[HOSTNAME];
                if (data && data.highlights && Array.isArray(data.highlights)) {
                    data.highlights.forEach(highlight => {
                        this.renderHighlight(highlight);
                    });
                }
            });

            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local' && changes[HOSTNAME]) {
                    const newData = changes[HOSTNAME].newValue;
                    if (newData && newData.highlights) {
                        this.syncHighlights(newData.highlights);
                    }
                }
            });
        }

        generateHighlightId() {
            return 'hl-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        }

        highlightText() {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.toString().trim().length === 0) {
                return false;
            }

            const range = selection.getRangeAt(0);
            const text = selection.toString();

            // Create highlight element
            const highlightId = this.generateHighlightId();
            const mark = document.createElement('mark');
            mark.className = 'text-highlight';
            mark.dataset.highlightId = highlightId;
            mark.style.backgroundColor = this.currentHighlightColor;
            mark.style.color = 'inherit';
            mark.style.padding = '2px 0';

            try {
                // Wrap selected text
                const contents = range.extractContents();
                mark.appendChild(contents);
                range.insertNode(mark);
            } catch (e) {
                // Fallback: create span wrapper
                const span = document.createElement('span');
                span.className = 'text-highlight';
                span.dataset.highlightId = highlightId;
                span.style.backgroundColor = this.currentHighlightColor;
                span.style.color = 'inherit';
                span.textContent = text;
                range.deleteContents();
                range.insertNode(span);
            }

            // Get anchor info
            const anchorElement = mark.parentElement || document.body;
            const anchorRect = anchorElement.getBoundingClientRect();
            const markRect = mark.getBoundingClientRect();
            const offset = {
                x: markRect.left - anchorRect.left,
                y: markRect.top - anchorRect.top
            };

            const selector = this.generateSelector(anchorElement);
            const highlight = {
                id: highlightId,
                type: 'text',
                text: text,
                anchor: {
                    selector: selector,
                    offset: offset
                },
                color: this.currentHighlightColor
            };

            this.highlightsMap.set(highlightId, { element: mark, type: 'text', data: highlight });
            this.saveHighlight(highlight);
            selection.removeAllRanges();
            return true;
        }

        toggleHighlightMode(active) {
            if (active !== undefined) {
                this.highlightModeActive = active;
            } else {
                this.highlightModeActive = !this.highlightModeActive;
            }
            if (this.highlightModeActive) {
                document.body.classList.add('highlight-mode-active');
                document.addEventListener('mouseup', this.handleMouseUp);
            } else {
                document.body.classList.remove('highlight-mode-active');
                document.removeEventListener('mouseup', this.handleMouseUp);
            }
            return this.highlightModeActive;
        }

        handleMouseUp(e) {
            if (!this.highlightModeActive) return;
            // Short timeout to let browser selection finish updating
            setTimeout(() => {
                const selection = window.getSelection();
                if (selection && selection.rangeCount > 0 && selection.toString().trim().length > 0) {
                    this.highlightText();
                }
            }, 10);
        }

        startAreaDrawing() {
            this.areaDrawingMode = true;
            document.body.style.cursor = 'crosshair';

            const onMouseDown = (e) => {
                const target = e.target;
                if (target.closest('.annotation-fab-host') || target.closest('.note-overlay-host')) {
                    return;
                }
                const host = target.getRootNode && target.getRootNode().host;
                if (host && host.classList && (host.classList.contains('annotation-fab-host') || host.classList.contains('note-overlay-host'))) {
                    return;
                }

                this.areaStartPos = { x: e.clientX, y: e.clientY };

                // Create preview rectangle
                this.areaPreview = document.createElement('div');
                this.areaPreview.className = 'area-highlight-preview';
                this.areaPreview.style.cssText = `
                    position: fixed;
                    left: ${e.clientX}px;
                    top: ${e.clientY}px;
                    width: 0;
                    height: 0;
                    background: ${this.currentHighlightColor};
                    opacity: 0.3;
                    pointer-events: none;
                    z-index: 2147483645;
                    border: 2px dashed ${this.currentHighlightColor};
                `;
                document.body.appendChild(this.areaPreview);

                const onMouseMove = (e) => {
                    if (!this.areaStartPos || !this.areaPreview) return;

                    const left = Math.min(this.areaStartPos.x, e.clientX);
                    const top = Math.min(this.areaStartPos.y, e.clientY);
                    const width = Math.abs(e.clientX - this.areaStartPos.x);
                    const height = Math.abs(e.clientY - this.areaStartPos.y);

                    this.areaPreview.style.left = left + 'px';
                    this.areaPreview.style.top = top + 'px';
                    this.areaPreview.style.width = width + 'px';
                    this.areaPreview.style.height = height + 'px';
                };

                const onMouseUp = (e) => {
                    if (!this.areaStartPos) return;

                    const left = Math.min(this.areaStartPos.x, e.clientX);
                    const top = Math.min(this.areaStartPos.y, e.clientY);
                    const width = Math.abs(e.clientX - this.areaStartPos.x);
                    const height = Math.abs(e.clientY - this.areaStartPos.y);

                    if (width > 10 && height > 10) {
                        // Create highlight
                        const highlightId = this.generateHighlightId();
                        const targetElement = document.elementFromPoint(left + width / 2, top + height / 2);
                        const anchorElement = targetElement || document.body;
                        const anchorRect = anchorElement.getBoundingClientRect();

                        const highlight = {
                            id: highlightId,
                            type: 'area',
                            anchor: {
                                selector: this.generateSelector(anchorElement),
                                offset: {
                                    x: left - anchorRect.left,
                                    y: top - anchorRect.top
                                }
                            },
                            bounds: {
                                x: left,
                                y: top,
                                width: width,
                                height: height
                            },
                            color: this.currentHighlightColor
                        };

                        this.createAreaHighlight(highlight);
                        this.saveHighlight(highlight);
                    }

                    // Cleanup
                    if (this.areaPreview) {
                        this.areaPreview.remove();
                        this.areaPreview = null;
                    }
                    this.areaStartPos = null;
                    this.areaDrawingMode = false;
                    document.body.style.cursor = '';
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                };

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousedown', onMouseDown, { once: true });
        }

        createAreaHighlight(highlight) {
            // Calculate position from anchor if available
            let left = highlight.bounds.x;
            let top = highlight.bounds.y;

            if (highlight.anchor && highlight.anchor.selector) {
                try {
                    const anchorElement = document.querySelector(highlight.anchor.selector);
                    if (anchorElement) {
                        const anchorRect = anchorElement.getBoundingClientRect();
                        left = anchorRect.left + highlight.anchor.offset.x - window.scrollX;
                        top = anchorRect.top + highlight.anchor.offset.y - window.scrollY;
                    }
                } catch (e) {
                    // Use stored bounds if anchor lookup fails
                }
            }

            const element = document.createElement('div');
            element.className = 'area-highlight';
            element.dataset.highlightId = highlight.id;
            element.style.cssText = `
                position: fixed;
                left: ${left}px;
                top: ${top}px;
                width: ${highlight.bounds.width}px;
                height: ${highlight.bounds.height}px;
                background: ${highlight.color};
                opacity: 0.3;
                pointer-events: none;
                z-index: 2147483645;
                border: 2px dashed ${highlight.color};
            `;
            document.body.appendChild(element);
            this.highlightsMap.set(highlight.id, { element: element, type: 'area', data: highlight });
        }

        renderHighlight(highlight) {
            if (highlight.type === 'text') {
                // Text highlights are already in DOM from storage
                // Just need to style them
                const elements = document.querySelectorAll(`[data-highlight-id="${highlight.id}"]`);
                elements.forEach(el => {
                    el.style.backgroundColor = highlight.color;
                    this.highlightsMap.set(highlight.id, { element: el, type: 'text', data: highlight });
                });
            } else if (highlight.type === 'area') {
                this.createAreaHighlight(highlight);
            }
        }

        syncHighlights(highlights) {
            const currentIds = new Set(this.highlightsMap.keys());
            const newIds = new Set(highlights.map(h => h.id));

            // Remove deleted highlights
            currentIds.forEach(id => {
                if (!newIds.has(id)) {
                    const highlightInfo = this.highlightsMap.get(id);
                    if (highlightInfo && highlightInfo.element) {
                        highlightInfo.element.remove();
                    }
                    this.highlightsMap.delete(id);
                }
            });

            // Add/update highlights
            highlights.forEach(highlight => {
                if (!this.highlightsMap.has(highlight.id)) {
                    this.renderHighlight(highlight);
                }
            });
        }

        clearAllHighlights() {
            this.highlightsMap.forEach((info, id) => {
                if (info.element) {
                    info.element.remove();
                }
            });
            this.highlightsMap.clear();

            chrome.storage.local.get([HOSTNAME], (result) => {
                const data = result[HOSTNAME] || {};
                data.highlights = [];
                chrome.storage.local.set({ [HOSTNAME]: data });
            });
        }

        saveHighlight(highlight) {
            chrome.storage.local.get([HOSTNAME], (result) => {
                const data = result[HOSTNAME] || { notes: [], highlights: [] };
                if (!data.highlights) data.highlights = [];

                const index = data.highlights.findIndex(h => h.id === highlight.id);
                if (index >= 0) {
                    data.highlights[index] = highlight;
                } else {
                    data.highlights.push(highlight);
                }

                chrome.storage.local.set({ [HOSTNAME]: data });
            });
        }

        generateSelector(element) {
            if (!element || element === document.body) {
                return 'body';
            }

            if (element.id) {
                const idSelector = `#${CSS.escape(element.id)}`;
                if (document.querySelectorAll(idSelector).length === 1) {
                    return idSelector;
                }
            }

            if (element.className && typeof element.className === 'string') {
                const classes = element.className.trim().split(/\s+/).filter(c => c);
                if (classes.length > 0) {
                    const classSelector = element.tagName.toLowerCase() + '.' + classes.map(c => CSS.escape(c)).join('.');
                    const matches = document.querySelectorAll(classSelector);
                    if (matches.length === 1) {
                        return classSelector;
                    }
                }
            }

            return 'body';
        }

        setColor(color) {
            this.currentHighlightColor = color;
        }
    }

    // FreehandDrawingManager class
    class FreehandDrawingManager {
        constructor() {
            this.isActive = false;
            this.isDrawing = false;
            this.isVisible = true;
            this.currentColor = '#ff4444';
            this.currentSize = 4;
            this.strokes = []; // Array of {color, size, points[]}
            this.currentStroke = null;
            this.canvas = null;
            this.ctx = null;
            this.paletteEl = null;
            this.undoStack = []; // For undo support

            this.colors = ['#ff4444', '#ff9900', '#ffdd00', '#44cc44', '#4488ff', '#cc44ff', '#ff44aa', '#ffffff', '#000000'];
            this.sizes = [2, 4, 8, 14];

            this.onMouseDown = this.onMouseDown.bind(this);
            this.onMouseMove = this.onMouseMove.bind(this);
            this.onMouseUp = this.onMouseUp.bind(this);
            this.onTouchStart = this.onTouchStart.bind(this);
            this.onTouchMove = this.onTouchMove.bind(this);
            this.onTouchEnd = this.onTouchEnd.bind(this);

            this.init();
        }

        init() {
            // Load saved strokes
            chrome.storage.local.get([HOSTNAME], (result) => {
                const data = result[HOSTNAME];
                if (data && data.drawings && Array.isArray(data.drawings)) {
                    this.strokes = data.drawings;
                    // If canvas exists, render them
                    if (this.canvas) this.redrawAll();
                }
            });

            // Listen for storage changes (e.g. popup toggling visibility)
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local' && changes[HOSTNAME]) {
                    const newData = changes[HOSTNAME].newValue;
                    if (newData && newData.drawingsVisible !== undefined) {
                        this.isVisible = newData.drawingsVisible;
                        if (this.canvas) {
                            this.canvas.style.display = this.isVisible ? 'block' : 'none';
                        }
                    }
                }
            });

            // Listen for messages from popup
            chrome.runtime.onMessage.addListener((message) => {
                if (message.action === 'setDrawingsVisible') {
                    this.setVisible(message.visible);
                } else if (message.action === 'clearDrawings') {
                    this.clearAll();
                }
            });
        }

        createCanvas() {
            if (this.canvas) return;

            this.canvas = document.createElement('canvas');
            this.canvas.id = '__freehand_canvas__';
            this.canvas.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                z-index: 2147483644;
                pointer-events: none;
                display: ${this.isVisible ? 'block' : 'none'};
            `;
            this._resizeCanvas();
            this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
            document.documentElement.appendChild(this.canvas);

            // Handle resize — canvas must cover the full document
            window.addEventListener('resize', () => {
                this._resizeCanvas();
                this.redrawAll();
            });

            // Re-check size on scroll in case page expanded (e.g. infinite scroll)
            window.addEventListener('scroll', () => {
                const needsResize = (
                    document.documentElement.scrollHeight > this.canvas.height ||
                    document.documentElement.scrollWidth > this.canvas.width
                );
                if (needsResize) {
                    this._resizeCanvas();
                    this.redrawAll();
                }
            }, { passive: true });

            this.redrawAll();
        }

        _resizeCanvas() {
            const w = Math.max(
                document.body.scrollWidth, document.documentElement.scrollWidth,
                document.body.offsetWidth, document.documentElement.offsetWidth,
                document.body.clientWidth, document.documentElement.clientWidth
            );
            const h = Math.max(
                document.body.scrollHeight, document.documentElement.scrollHeight,
                document.body.offsetHeight, document.documentElement.offsetHeight,
                document.body.clientHeight, document.documentElement.clientHeight
            );
            this.canvas.width = w;
            this.canvas.height = h;
            this.canvas.style.width = w + 'px';
            this.canvas.style.height = h + 'px';
        }

        createPalette() {
            if (this.paletteEl) {
                this.paletteEl.style.display = 'flex';
                return;
            }

            const palette = document.createElement('div');
            palette.id = '__freehand_palette__';
            palette.style.cssText = `
                position: fixed;
                bottom: 90px;
                right: 18px;
                background: rgba(15,15,16,0.95);
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 16px;
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                z-index: 2147483647;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                backdrop-filter: blur(8px);
                font-family: 'Segoe UI', system-ui, sans-serif;
                min-width: 180px;
                cursor: default;
                user-select: none;
            `;

            // Header
            const header = document.createElement('div');
            header.style.cssText = `
                display: flex; align-items: center; justify-content: space-between;
                margin-bottom: 2px;
            `;
            const title = document.createElement('span');
            title.textContent = 'Draw';
            title.style.cssText = `color: #a6adc8; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;`;
            
            const doneBtn = document.createElement('button');
            doneBtn.textContent = '✕ Done';
            doneBtn.style.cssText = `
                background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1);
                color: #cdd6f4; border-radius: 8px; padding: 3px 8px; font-size: 11px;
                cursor: pointer; font-family: inherit;
            `;
            doneBtn.addEventListener('click', () => this.deactivate());
            doneBtn.addEventListener('mouseenter', () => doneBtn.style.background = 'rgba(255,255,255,0.15)');
            doneBtn.addEventListener('mouseleave', () => doneBtn.style.background = 'rgba(255,255,255,0.08)');
            header.appendChild(title);
            header.appendChild(doneBtn);

            // Color swatches
            const colorsLabel = document.createElement('div');
            colorsLabel.textContent = 'Color';
            colorsLabel.style.cssText = `color: #585b70; font-size: 10px; font-weight: 500; letter-spacing: 0.05em; margin-top: 2px;`;
            
            const colorsRow = document.createElement('div');
            colorsRow.style.cssText = `display: flex; flex-wrap: wrap; gap: 5px;`;
            this.colorSwatches = {};
            this.colors.forEach(color => {
                const swatch = document.createElement('button');
                swatch.style.cssText = `
                    width: 22px; height: 22px; border-radius: 50%; background: ${color};
                    border: 2px solid transparent; cursor: pointer; flex-shrink: 0;
                    transition: transform 0.15s, border-color 0.15s;
                `;
                if (color === this.currentColor) {
                    swatch.style.borderColor = '#fff';
                    swatch.style.transform = 'scale(1.2)';
                }
                swatch.addEventListener('click', () => {
                    this.currentColor = color;
                    Object.values(this.colorSwatches).forEach(s => {
                        s.style.borderColor = 'transparent';
                        s.style.transform = 'scale(1)';
                    });
                    swatch.style.borderColor = '#fff';
                    swatch.style.transform = 'scale(1.2)';
                });
                colorsRow.appendChild(swatch);
                this.colorSwatches[color] = swatch;
            });

            // Size picker
            const sizeLabel = document.createElement('div');
            sizeLabel.textContent = 'Size';
            sizeLabel.style.cssText = `color: #585b70; font-size: 10px; font-weight: 500; letter-spacing: 0.05em;`;

            const sizesRow = document.createElement('div');
            sizesRow.style.cssText = `display: flex; gap: 6px; align-items: center;`;
            this.sizeBtns = {};
            this.sizes.forEach(size => {
                const btn = document.createElement('button');
                btn.style.cssText = `
                    width: ${10 + size * 2}px; height: ${10 + size * 2}px; border-radius: 50%;
                    background: ${size === this.currentSize ? '#fff' : 'rgba(255,255,255,0.3)'};
                    border: 2px solid ${size === this.currentSize ? '#fff' : 'rgba(255,255,255,0.2)'};
                    cursor: pointer; flex-shrink: 0; transition: background 0.15s, border-color 0.15s;
                `;
                btn.addEventListener('click', () => {
                    this.currentSize = size;
                    Object.values(this.sizeBtns).forEach(b => {
                        b.style.background = 'rgba(255,255,255,0.3)';
                        b.style.borderColor = 'rgba(255,255,255,0.2)';
                    });
                    btn.style.background = '#fff';
                    btn.style.borderColor = '#fff';
                });
                sizesRow.appendChild(btn);
                this.sizeBtns[size] = btn;
            });

            // Undo + Clear buttons
            const actionsRow = document.createElement('div');
            actionsRow.style.cssText = `display: flex; gap: 6px; margin-top: 2px;`;
            
            const undoBtn = this._makeActionBtn('↩ Undo', () => this.undo());
            const clearBtn = this._makeActionBtn('✕ Clear', () => this.clearAll(), '#f38ba8');
            actionsRow.appendChild(undoBtn);
            actionsRow.appendChild(clearBtn);

            palette.appendChild(header);
            palette.appendChild(colorsLabel);
            palette.appendChild(colorsRow);
            palette.appendChild(sizeLabel);
            palette.appendChild(sizesRow);
            palette.appendChild(actionsRow);

            document.body.appendChild(palette);
            this.paletteEl = palette;

            // Prevent palette clicks from propagating to canvas
            palette.addEventListener('mousedown', e => e.stopPropagation());
        }

        _makeActionBtn(text, onClick, hoverColor = '#89b4fa') {
            const btn = document.createElement('button');
            btn.textContent = text;
            btn.style.cssText = `
                flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
                color: #cdd6f4; border-radius: 8px; padding: 5px 0; font-size: 11px;
                cursor: pointer; font-family: inherit; transition: background 0.15s, color 0.15s;
            `;
            btn.addEventListener('click', onClick);
            btn.addEventListener('mouseenter', () => { btn.style.color = hoverColor; btn.style.background = 'rgba(255,255,255,0.12)'; });
            btn.addEventListener('mouseleave', () => { btn.style.color = '#cdd6f4'; btn.style.background = 'rgba(255,255,255,0.06)'; });
            return btn;
        }

        activate() {
            this.isActive = true;
            this.createCanvas();
            this.createPalette();

            // Enable pointer events on canvas
            this.canvas.style.pointerEvents = 'all';
            document.body.style.cursor = 'none'; // We'll use a custom cursor

            this.canvas.addEventListener('mousedown', this.onMouseDown);
            this.canvas.addEventListener('mousemove', this.onMouseMove);
            this.canvas.addEventListener('mouseup', this.onMouseUp);
            this.canvas.addEventListener('mouseleave', this.onMouseUp);
            this.canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
            this.canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
            this.canvas.addEventListener('touchend', this.onTouchEnd);
        }

        deactivate() {
            this.isActive = false;
            if (this.canvas) {
                this.canvas.style.pointerEvents = 'none';
                this.canvas.removeEventListener('mousedown', this.onMouseDown);
                this.canvas.removeEventListener('mousemove', this.onMouseMove);
                this.canvas.removeEventListener('mouseup', this.onMouseUp);
                this.canvas.removeEventListener('mouseleave', this.onMouseUp);
                this.canvas.removeEventListener('touchstart', this.onTouchStart);
                this.canvas.removeEventListener('touchmove', this.onTouchMove);
                this.canvas.removeEventListener('touchend', this.onTouchEnd);
                // Redraw without cursor
                this.redrawAll();
            }
            if (this.paletteEl) {
                this.paletteEl.style.display = 'none';
            }
            document.body.style.cursor = '';

            // Notify FloatingToolbarManager to update button state
            window.dispatchEvent(new CustomEvent('freehand-deactivated'));
        }

        setVisible(visible) {
            this.isVisible = visible;
            if (this.canvas) {
                this.canvas.style.display = visible ? 'block' : 'none';
            }
            // Persist
            chrome.storage.local.get([HOSTNAME], (result) => {
                const data = result[HOSTNAME] || {};
                data.drawingsVisible = visible;
                chrome.storage.local.set({ [HOSTNAME]: data });
            });
        }

        onMouseDown(e) {
            if (e.button !== 0) return;
            this.isDrawing = true;
            this.currentStroke = {
                color: this.currentColor,
                size: this.currentSize,
                points: [{ x: e.pageX, y: e.pageY }]
            };
            this.drawCursor(e.pageX, e.pageY);
        }

        onMouseMove(e) {
            // Redraw to show cursor dot
            if (this.isDrawing && this.currentStroke) {
                this.currentStroke.points.push({ x: e.pageX, y: e.pageY });
                this.redrawAll();
                this.drawStroke(this.currentStroke);
            } else {
                this.redrawAll();
            }
            this.drawCursor(e.pageX, e.pageY);
        }

        onMouseUp(e) {
            if (!this.isDrawing || !this.currentStroke) return;
            this.isDrawing = false;
            if (this.currentStroke.points.length > 1) {
                this.strokes.push(this.currentStroke);
                this.undoStack.push(this.strokes.length - 1);
                this.saveDrawings();
            }
            this.currentStroke = null;
            this.redrawAll();
        }

        onTouchStart(e) {
            e.preventDefault();
            const touch = e.touches[0];
            this.isDrawing = true;
            this.currentStroke = {
                color: this.currentColor,
                size: this.currentSize,
                points: [{ x: touch.pageX, y: touch.pageY }]
            };
        }

        onTouchMove(e) {
            e.preventDefault();
            if (!this.isDrawing || !this.currentStroke) return;
            const touch = e.touches[0];
            this.currentStroke.points.push({ x: touch.pageX, y: touch.pageY });
            this.redrawAll();
            this.drawStroke(this.currentStroke);
        }

        onTouchEnd(e) {
            this.onMouseUp(e);
        }

        drawCursor(x, y) {
            const ctx = this.ctx;
            const r = this.currentSize / 2 + 1;
            ctx.save();
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = this.currentColor;
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.8)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
        }

        drawStroke(stroke) {
            if (!stroke || stroke.points.length < 2) return;
            const ctx = this.ctx;
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = stroke.size;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
            for (let i = 1; i < stroke.points.length - 1; i++) {
                const midX = (stroke.points[i].x + stroke.points[i + 1].x) / 2;
                const midY = (stroke.points[i].y + stroke.points[i + 1].y) / 2;
                ctx.quadraticCurveTo(stroke.points[i].x, stroke.points[i].y, midX, midY);
            }
            const last = stroke.points[stroke.points.length - 1];
            ctx.lineTo(last.x, last.y);
            ctx.stroke();
            ctx.restore();
        }

        redrawAll() {
            if (!this.ctx || !this.canvas) return;
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.strokes.forEach(stroke => this.drawStroke(stroke));
        }

        undo() {
            if (this.strokes.length === 0) return;
            this.strokes.pop();
            this.redrawAll();
            this.saveDrawings();
        }

        clearAll() {
            this.strokes = [];
            this.undoStack = [];
            this.redrawAll();
            this.saveDrawings();
        }

        saveDrawings() {
            chrome.storage.local.get([HOSTNAME], (result) => {
                const data = result[HOSTNAME] || {};
                data.drawings = this.strokes;
                chrome.storage.local.set({ [HOSTNAME]: data });
            });
        }
    }

    // FloatingToolbarManager class
    class FloatingToolbarManager {
        constructor(noteManager, highlightManager, freehandDrawingManager) {
            this.noteManager = noteManager;
            this.highlightManager = highlightManager;
            this.freehandDrawingManager = freehandDrawingManager;
            this.container = null;
            this.shadowRoot = null;
            this.shell = null;
            this.mainButton = null;
            this.pinnedOpen = false;
            this.hoverActive = false;
            this.hoverRadius = 165;
            this.isDragging = false;
            this.dragMoved = false;
            this.ignoreNextToggleClick = false;
            this.dragStart = { x: 0, y: 0, left: 0, top: 0 };
            this.onDragMoveBound = this.onDragMove.bind(this);
            this.onDragEndBound = this.onDragEnd.bind(this);
            this.onPointerTrackBound = this.onPointerTrack.bind(this);
            this.defaultNoteStyle = {
                type: 'paper',
                bg: '#ffffff',
                text: '#101010',
                opacity: 0.97,
                border: 'rgba(0,0,0,0.2)'
            };
            this.init();
        }

        init() {
            this.createToolbar();
            this.setupEventListeners();
        }

        createToolbar() {
            this.container = document.createElement('div');
            this.container.id = 'annotation-fab';
            this.container.className = 'annotation-fab-host';

            this.shadowRoot = this.container.attachShadow({ mode: 'open' });

            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = chrome.runtime.getURL('content.css');
            this.shadowRoot.appendChild(link);

            this.shell = document.createElement('div');
            this.shell.className = 'annotation-fab-shell';
            this.shell.innerHTML = `
                <button class="annotation-fab-action annotation-fab-action-highlight" data-action="highlight" title="Highlight (coming soon)" aria-label="Highlight (coming soon)">
                    <span class="annotation-fab-ring"></span>
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M3 21l4.5-1 10-10-3.5-3.5-10 10L3 21z"></path>
                        <path d="M13.5 6.5l3.5 3.5"></path>
                    </svg>
                </button>
                <button class="annotation-fab-action annotation-fab-action-note" data-action="note" title="Add note" aria-label="Add note">
                    <span class="annotation-fab-ring"></span>
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M5 3h14v18H5z"></path>
                        <path d="M9 8h6"></path>
                        <path d="M9 12h6"></path>
                    </svg>
                </button>
                <button class="annotation-fab-main" data-action="toggle" title="Annotation tools" aria-label="Annotation tools">
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <circle cx="12" cy="12" r="3.2"></circle>
                        <path d="M12 4v3"></path>
                        <path d="M12 17v3"></path>
                        <path d="M4 12h3"></path>
                        <path d="M17 12h3"></path>
                    </svg>
                </button>
            `;

            this.shadowRoot.appendChild(this.shell);
            document.body.appendChild(this.container);
            this.mainButton = this.shell.querySelector('.annotation-fab-main');
        }

        setupEventListeners() {
            this.shell.addEventListener('click', (e) => {
                const button = e.target.closest('button[data-action]');
                if (!button) return;

                const action = button.dataset.action;
                e.preventDefault();
                e.stopPropagation();

                if (action === 'toggle') {
                    if (this.ignoreNextToggleClick) {
                        this.ignoreNextToggleClick = false;
                        return;
                    }
                    if (this.pinnedOpen) {
                        this.pinnedOpen = false;
                        this.hoverActive = false;
                    } else {
                        this.pinnedOpen = true;
                    }
                    this.updateOpenState();
                    return;
                }

                if (action === 'note') {
                    this.startNotePlacement();
                    return;
                }

                if (action === 'highlight') {
                    const highlightBtn = button;
                    if (this.freehandDrawingManager.isActive) {
                        this.freehandDrawingManager.deactivate();
                        highlightBtn.classList.remove('active');
                    } else {
                        this.freehandDrawingManager.activate();
                        highlightBtn.classList.add('active');
                        this.pinnedOpen = false;
                        this.hoverActive = false;
                        this.updateOpenState();
                    }
                    return;
                }
            });

            this.shell.addEventListener('mouseenter', () => {
                if (this.isDragging) return;
                this.hoverActive = true;
                this.updateOpenState();
            });

            document.addEventListener('mousemove', this.onPointerTrackBound, true);

            document.addEventListener('click', (e) => {
                if (!this.pinnedOpen) return;
                const path = e.composedPath ? e.composedPath() : [];
                if (path.includes(this.container)) return;
                this.pinnedOpen = false;
                this.updateOpenState();
            }, true);

            if (this.mainButton) {
                this.mainButton.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    this.startDrag(e);
                });
            }

            // Listen for freehand deactivation (e.g. from Done button in palette)
            window.addEventListener('freehand-deactivated', () => {
                const highlightBtn = this.shell.querySelector('.annotation-fab-action-highlight');
                if (highlightBtn) highlightBtn.classList.remove('active');
            });
        }

        startNotePlacement() {
            this.noteManager.pendingNoteStyle = this.defaultNoteStyle;
            this.noteManager.startPlacementMode();
            this.pinnedOpen = false;
            this.hoverActive = false;
            this.updateOpenState();
        }

        startDrag(e) {
            this.isDragging = true;
            this.dragMoved = false;
            this.ignoreNextToggleClick = false;
            this.pinnedOpen = false;
            this.hoverActive = false;
            this.updateOpenState();

            const rect = this.shell.getBoundingClientRect();
            this.dragStart = {
                x: e.clientX,
                y: e.clientY,
                left: rect.left,
                top: rect.top
            };

            this.shell.style.left = rect.left + 'px';
            this.shell.style.top = rect.top + 'px';
            this.shell.style.right = 'auto';
            this.shell.style.bottom = 'auto';
            this.shell.classList.add('dragging');

            document.addEventListener('mousemove', this.onDragMoveBound, true);
            document.addEventListener('mouseup', this.onDragEndBound, true);
            e.preventDefault();
        }

        onDragMove(e) {
            if (!this.isDragging) return;
            const dx = e.clientX - this.dragStart.x;
            const dy = e.clientY - this.dragStart.y;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
                this.dragMoved = true;
            }

            const rect = this.shell.getBoundingClientRect();
            const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
            const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
            const nextLeft = Math.min(maxLeft, Math.max(8, this.dragStart.left + dx));
            const nextTop = Math.min(maxTop, Math.max(8, this.dragStart.top + dy));
            this.shell.style.left = nextLeft + 'px';
            this.shell.style.top = nextTop + 'px';
            e.preventDefault();
        }

        onDragEnd() {
            if (!this.isDragging) return;
            this.isDragging = false;
            this.shell.classList.remove('dragging');
            document.removeEventListener('mousemove', this.onDragMoveBound, true);
            document.removeEventListener('mouseup', this.onDragEndBound, true);
            if (this.dragMoved) {
                this.ignoreNextToggleClick = true;
            }
            this.dragMoved = false;
        }

        onPointerTrack(e) {
            if (this.pinnedOpen || !this.hoverActive || this.isDragging || !this.mainButton) {
                return;
            }
            const rect = this.mainButton.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const dx = e.clientX - centerX;
            const dy = e.clientY - centerY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > this.hoverRadius) {
                this.hoverActive = false;
                this.updateOpenState();
            }
        }

        updateOpenState() {
            const isOpen = this.pinnedOpen || this.hoverActive;
            this.shell.classList.toggle('open', isOpen);
        }
    }

    // Initialize NoteManager
    const noteManager = new NoteManager();

    // Initialize HighlightManager
    const highlightManager = new HighlightManager();

    // Initialize FreehandDrawingManager
    const freehandDrawingManager = new FreehandDrawingManager();

    // Initialize FloatingToolbarManager
    const floatingToolbarManager = new FloatingToolbarManager(noteManager, highlightManager, freehandDrawingManager);

})();
