document.addEventListener('DOMContentLoaded', () => {
    const notesList = document.getElementById('notes-list');
    const emptyState = document.getElementById('empty-state');
    const currentDomainSpan = document.getElementById('current-domain');
    const saveStatusSpan = document.getElementById('save-status');

    let currentHostname = '';
    let currentNotes = [];
    let debounceTimer;



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
