// pages/notes.js

export class NotesManager {
    constructor(appInstance) {
        this.app = appInstance; // Reference to the main application
        this.drawingCanvas = null;
        this.drawingContext = null;
        this.drawingState = {
            isDrawing: false,
            lastX: 0,
            lastY: 0,
            currentColor: '#000000',
            currentSize: 5
        };

        this.setupNotesEvents();
        this.setupDrawingEvents();
        this.loadSavedData();
    }

    setupNotesEvents() {
        const textModeBtn = document.getElementById('textModeBtn');
        const drawModeBtn = document.getElementById('drawModeBtn');
        const saveNotesBtn = document.getElementById('saveNotesBtn');
        const notesTextarea = document.getElementById('notesTextarea');

        textModeBtn.addEventListener('click', () => this.switchNotesMode('text'));
        drawModeBtn.addEventListener('click', () => this.switchNotesMode('draw'));

        let saveTimeout;
        notesTextarea.addEventListener('input', () => {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => this.autoSaveNotes(), 1000);
        });

        saveNotesBtn.addEventListener('click', () => this.saveNotes());
    }

    setupDrawingEvents() {
        this.drawingCanvas = document.getElementById('drawingCanvas');
        if (!this.drawingCanvas) return;

        this.drawingContext = this.drawingCanvas.getContext('2d');
        this.drawingContext.lineCap = 'round';
        this.drawingContext.lineJoin = 'round';

        document.querySelectorAll('.color-option').forEach(option => {
            option.addEventListener('click', () => {
                document.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                this.drawingState.currentColor = option.dataset.color;
            });
        });

        const brushSize = document.getElementById('brushSize');
        const brushSizeValue = document.getElementById('brushSizeValue');
        brushSize.addEventListener('input', () => {
            this.drawingState.currentSize = brushSize.value;
            brushSizeValue.textContent = brushSize.value + 'px';
        });

        this.drawingCanvas.addEventListener('mousedown', (e) => this.startDrawing(e));
        this.drawingCanvas.addEventListener('mousemove', (e) => this.draw(e));
        this.drawingCanvas.addEventListener('mouseup', () => this.stopDrawing());
        this.drawingCanvas.addEventListener('mouseout', () => this.stopDrawing());

        this.drawingCanvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            const mouseEvent = new MouseEvent('mousedown', {
                clientX: touch.clientX,
                clientY: touch.clientY
            });
            this.drawingCanvas.dispatchEvent(mouseEvent);
        });

        this.drawingCanvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            const mouseEvent = new MouseEvent('mousemove', {
                clientX: touch.clientX,
                clientY: touch.clientY
            });
            this.drawingCanvas.dispatchEvent(mouseEvent);
        });

        this.drawingCanvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            const mouseEvent = new MouseEvent('mouseup', {});
            this.drawingCanvas.dispatchEvent(mouseEvent);
        });

        const clearCanvasBtn = document.getElementById('clearCanvasBtn');
        clearCanvasBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the canvas?')) {
                this.drawingContext.clearRect(0, 0, this.drawingCanvas.width, this.drawingCanvas.height);
            }
        });
    }

    switchNotesMode(mode) {
        const textModeBtn = document.getElementById('textModeBtn');
        const drawModeBtn = document.getElementById('drawModeBtn');
        const textMode = document.getElementById('textMode');
        const drawMode = document.getElementById('drawMode');
        
        if (mode === 'text') {
            textModeBtn.classList.add('active');
            drawModeBtn.classList.remove('active');
            textMode.style.display = 'block';
            drawMode.style.display = 'none';
        } else {
            drawModeBtn.classList.add('active');
            textModeBtn.classList.remove('active');
            drawMode.style.display = 'block';
            textMode.style.display = 'none';
            // We'll call the resize from the main app, which now holds this logic.
            setTimeout(() => this.app.resizeCanvas(), 100);
        }
    }

    startDrawing(e) {
        this.drawingState.isDrawing = true;
        const rect = this.drawingCanvas.getBoundingClientRect();
        this.drawingState.lastX = (e.clientX || e.touches?.[0]?.clientX) - rect.left;
        this.drawingState.lastY = (e.clientY || e.touches?.[0]?.clientY) - rect.top;
    }

    draw(e) {
        if (!this.drawingState.isDrawing) return;

        e.preventDefault();
        const rect = this.drawingCanvas.getBoundingClientRect();
        const currentX = (e.clientX || e.touches?.[0]?.clientX) - rect.left;
        const currentY = (e.clientY || e.touches?.[0]?.clientY) - rect.top;

        this.drawingContext.beginPath();
        this.drawingContext.moveTo(this.drawingState.lastX, this.drawingState.lastY);
        this.drawingContext.lineTo(currentX, currentY);
        this.drawingContext.strokeStyle = this.drawingState.currentColor;
        this.drawingContext.lineWidth = this.drawingState.currentSize;
        this.drawingContext.stroke();

        this.drawingState.lastX = currentX;
        this.drawingState.lastY = currentY;
    }

    stopDrawing() {
        this.drawingState.isDrawing = false;
    }

    autoSaveNotes() {
        const notesContent = document.getElementById('notesTextarea').value;
        localStorage.setItem('aiTutorNotes', notesContent);
        this.app.showMascotMessage("Notes auto-saved! 💾");
    }

    saveNotes() {
        const notesContent = document.getElementById('notesTextarea').value;
        const canvasData = this.drawingCanvas?.toDataURL();
        
        const notesData = {
            text: notesContent,
            drawing: canvasData,
            timestamp: new Date().toISOString()
        };

        localStorage.setItem('aiTutorNotes', JSON.stringify(notesData));
        this.app.showMascotMessage("Notes saved successfully! 💾");
    }

    loadSavedData() {
        const savedNotes = localStorage.getItem('aiTutorNotes');
        if (savedNotes) {
            try {
                const notesData = JSON.parse(savedNotes);
                if (typeof notesData === 'string') {
                    document.getElementById('notesTextarea').value = notesData;
                } else {
                    document.getElementById('notesTextarea').value = notesData.text || '';
                    if (notesData.drawing && this.drawingCanvas) {
                        const img = new Image();
                        img.onload = () => {
                            this.app.resizeCanvas(); // Ensure canvas is the right size before drawing.
                            this.drawingContext.drawImage(img, 0, 0);
                        };
                        img.src = notesData.drawing;
                    }
                }
            } catch (e) {
                console.error('Error loading saved notes:', e);
            }
        }
    }
}