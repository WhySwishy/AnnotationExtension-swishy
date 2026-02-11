document.addEventListener('DOMContentLoaded', () => {
    const notesList = document.getElementById('notes-list');
    const emptyState = document.getElementById('empty-state');
    const createNoteBtn = document.getElementById('create-note-btn');
    const currentDomainSpan = document.getElementById('current-domain');
    const saveStatusSpan = document.getElementById('save-status');
    const designPanel = document.getElementById('design-panel');
    
    // Design Controls
    const themeSelect = document.getElementById('theme-select');
    const bgColorInput = document.getElementById('bg-color');
    const bgOpacityInput = document.getElementById('bg-opacity');
    const textColorInput = document.getElementById('text-color');

    let currentHostname = '';
    let currentNotes = [];
    let placementMode = false;
    let debounceTimer;
    let placementMessageListener = null;

    // Theme Presets
    const PRESETS = {
        glass: { bg: '#1e1e2e', text: '#cdd6f4', opacity: 0.4, border: 'rgba(255, 255, 255, 0.1)' },
        paper: { bg: '#ffffff', text: '#202124', opacity: 0.95, border: '#e0e0e0' },
        postit: { bg: '#fff740', text: '#202124', opacity: 0.95, border: 'rgba(0,0,0,0.1)' },
        custom: { bg: '#1e1e2e', text: '#cdd6f4', opacity: 0.6, border: 'rgba(255, 255, 255, 0.1)' }
    };

    // Get Current Tab Hostname
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) return;

        try {
            const url = new URL(tabs[0].url);
            currentHostname = url.hostname;
            currentDomainSpan.textContent = currentHostname;
            loadNotes(currentHostname);
        } catch (e) {
            currentDomainSpan.textContent = "Invalid Domain";
            createNoteBtn.disabled = true;
        }
    });

    // Load Notes
    function loadNotes(hostname) {
        chrome.storage.local.get([hostname], (result) => {
            const data = result[hostname] || { notes: [] };
            
            // Migration: Convert old format if needed
            if (data.text !== undefined && !data.notes) {
                // Old format detected, will be migrated by content script
                currentNotes = [];
            } else {
                currentNotes = data.notes || [];
            }

            renderNotesList();
        });
    }

    // Render Notes List
    function renderNotesList() {
        notesList.innerHTML = '';

        if (currentNotes.length === 0) {
            emptyState.style.display = 'block';
            notesList.style.display = 'none';
            return;
        }

        emptyState.style.display = 'none';
        notesList.style.display = 'block';

        currentNotes.forEach(note => {
            const noteCard = createNoteCard(note);
            notesList.appendChild(noteCard);
        });
    }

    // Create Note Card
    function createNoteCard(note) {
        const card = document.createElement('div');
        card.className = 'note-card';
        card.dataset.noteId = note.id;

        const preview = note.text ? (note.text.substring(0, 50) + (note.text.length > 50 ? '...' : '')) : '(Empty note)';
        const isVisible = note.visible !== false;

        card.innerHTML = `
            <div class="note-card-header">
                <label class="note-visibility-toggle">
                    <input type="checkbox" ${isVisible ? 'checked' : ''} data-note-id="${note.id}">
                    <span class="toggle-slider"></span>
                </label>
                <div class="note-preview">${escapeHtml(preview)}</div>
            </div>
            <div class="note-card-actions">
                <button class="action-btn edit-btn" data-note-id="${note.id}" title="Edit">✎</button>
                <button class="action-btn delete-btn-card" data-note-id="${note.id}" title="Delete">×</button>
            </div>
        `;

        // Bind events
        const visibilityToggle = card.querySelector('input[type="checkbox"]');
        visibilityToggle.addEventListener('change', (e) => {
            toggleNoteVisibility(note.id, e.target.checked);
        });

        const editBtn = card.querySelector('.edit-btn');
        editBtn.addEventListener('click', () => {
            editNote(note);
        });

        const deleteBtn = card.querySelector('.delete-btn-card');
        deleteBtn.addEventListener('click', () => {
            deleteNote(note.id);
        });

        return card;
    }

    // Create New Note
    createNoteBtn.addEventListener('click', () => {
        startPlacementMode();
    });

    // Keyboard shortcut (N key)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'n' || e.key === 'N') {
            if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                // Only trigger if not in an input field
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                    startPlacementMode();
                }
            }
        }
    });

    // Start Placement Mode
    function startPlacementMode() {
        if (placementMode) return;

        placementMode = true;
        createNoteBtn.disabled = true;
        createNoteBtn.textContent = 'Click on page to place note...';
        saveStatusSpan.textContent = 'Click on the page where you want to place the note';
        saveStatusSpan.className = 'placing';

        // Get default style from design controls
        const style = getCurrentStyle();

        // Send message to content script with style
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, { 
                action: 'startPlacement',
                style: style
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error:', chrome.runtime.lastError);
                    cancelPlacementMode();
                }
            });
        });

        // Listen for note created message
        placementMessageListener = (message) => {
            if (message.action === 'noteCreated') {
                if (placementMessageListener) {
                    chrome.runtime.onMessage.removeListener(placementMessageListener);
                    placementMessageListener = null;
                }
                // Reload notes to get the new one
                loadNotes(currentHostname);
                cancelPlacementMode();
            }
        };
        chrome.runtime.onMessage.addListener(placementMessageListener);
    }

    // Cancel Placement Mode
    function cancelPlacementMode() {
        placementMode = false;
        createNoteBtn.disabled = false;
        createNoteBtn.innerHTML = '<span>+</span> Create New Note';
        saveStatusSpan.textContent = 'Ready';
        saveStatusSpan.className = '';

        if (placementMessageListener) {
            chrome.runtime.onMessage.removeListener(placementMessageListener);
            placementMessageListener = null;
        }

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'cancelPlacement' });
        });
    }


    // Get Current Style
    function getCurrentStyle() {
        const type = themeSelect.value;
        let style;
        
        if (type !== 'custom') {
            style = PRESETS[type];
        } else {
            style = {
                bg: bgColorInput.value,
                text: textColorInput.value,
                opacity: bgOpacityInput.value,
                border: 'rgba(255,255,255,0.1)'
            };
        }

        return {
            type: type,
            bg: style.bg,
            text: style.text,
            opacity: style.opacity,
            border: style.border
        };
    }

    // Toggle Note Visibility
    function toggleNoteVisibility(noteId, visible) {
        const note = currentNotes.find(n => n.id === noteId);
        if (!note) return;

        note.visible = visible;
        saveNotes();

        // Update in content script
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, {
                action: 'updateNote',
                noteId: noteId,
                noteData: { visible: visible }
            });
        });
    }

    // Edit Note
    function editNote(note) {
        const newText = prompt('Edit note:', note.text || '');
        if (newText === null) return; // User cancelled

        note.text = newText;
        saveNotes();
        renderNotesList();

        // Update in content script
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, {
                action: 'updateNote',
                noteId: note.id,
                noteData: { text: newText }
            });
        });
    }

    // Delete Note
    function deleteNote(noteId) {
        if (!confirm('Are you sure you want to delete this note?')) return;

        currentNotes = currentNotes.filter(n => n.id !== noteId);
        saveNotes();
        renderNotesList();

        // Delete in content script
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, {
                action: 'deleteNote',
                noteId: noteId
            });
        });
    }

    // Save Notes
    function saveNotes() {
        if (!currentHostname) return;

        saveStatusSpan.textContent = 'Saving...';
        saveStatusSpan.className = 'saving';

        chrome.storage.local.get([currentHostname], (result) => {
            const existingData = result[currentHostname] || {};
            const mergedData = {
                ...existingData,
                notes: currentNotes
            };

            chrome.storage.local.set({ [currentHostname]: mergedData }, () => {
                saveStatusSpan.textContent = 'Saved';
                saveStatusSpan.className = 'saved';
                setTimeout(() => {
                    saveStatusSpan.textContent = 'Ready';
                    saveStatusSpan.className = '';
                }, 1000);
            });
        });
    }

    // Theme Controls
    themeSelect.addEventListener('change', (e) => {
        const type = e.target.value;
        if (type !== 'custom') {
            resetToPreset(type);
        }
        applyThemeToPopup();
    });

    function resetToPreset(type) {
        const preset = PRESETS[type];
        if (preset) {
            bgColorInput.value = preset.bg;
            textColorInput.value = preset.text;
            bgOpacityInput.value = preset.opacity;
        }
    }

    function applyThemeToPopup() {
        const bg = bgColorInput.value;
        const text = textColorInput.value;
        document.documentElement.style.setProperty('--bg-color', bg);
        document.documentElement.style.setProperty('--text-color', text);
        document.documentElement.style.setProperty('--secondary-bg', adjustColor(bg, 20));
    }

    function adjustColor(hex, amount) {
        let col = hex.replace('#', '');
        let num = parseInt(col, 16);
        let r = (num >> 16) + amount;
        let b = ((num >> 8) & 0x00FF) + amount;
        let g = (num & 0x0000FF) + amount;

        r = r > 255 ? 255 : r < 0 ? 0 : r;
        b = b > 255 ? 255 : b < 0 ? 0 : b;
        g = g > 255 ? 255 : g < 0 ? 0 : g;

        return "#" + (g | (b << 8) | (r << 16)).toString(16).padStart(6, '0');
    }

    [bgColorInput, textColorInput, bgOpacityInput].forEach(input => {
        input.addEventListener('input', () => {
            if (themeSelect.value !== 'custom') {
                themeSelect.value = 'custom';
            }
            applyThemeToPopup();
        });
    });

    // Listen for storage changes
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[currentHostname]) {
            const newData = changes[currentHostname].newValue;
            if (newData && newData.notes) {
                currentNotes = newData.notes;
                renderNotesList();
            }
        }
    });

    // Helper
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
});
