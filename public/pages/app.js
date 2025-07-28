// pages/app-manager.js

export class AppManager {
    constructor(appInstance) {
        this.app = appInstance; // Reference to the main application
        this.sessionTimer = null;
        this.sessionDuration = 0;
        this.currentPage = 'landingPage';
        
        this.setupGlobalEvents();
    }
    
    // Sets up event listeners that apply globally to the entire application.
    setupGlobalEvents() {
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === ' ' && e.target === document.body && this.currentPage === 'mainInterface') {
                e.preventDefault();
                this.app.speechManager.toggleVoiceRecognition();
            } else if (e.key === 'Escape') {
                this.app.closeNotesPanel();
            }
        });
        
        // Window resize
        window.addEventListener('resize', () => {
            const drawMode = document.getElementById('drawMode');
            if (drawMode && drawMode.style.display !== 'none') {
                this.app.notesManager.resizeCanvas();
            }
        });
        
        // Orientation change
        window.addEventListener('orientationchange', () => {
            setTimeout(() => {
                const drawMode = document.getElementById('drawMode');
                if (drawMode && drawMode.style.display !== 'none') {
                    this.app.notesManager.resizeCanvas();
                }
            }, 500);
        });
    }

    // Displays a specific page and updates the app state.
    switchToPage(pageId) {
        document.querySelectorAll('.page').forEach(page => {
            page.classList.remove('active');
        });
        
        document.getElementById(pageId).classList.add('active');
        this.currentPage = pageId;
        
        this.updateDisplay();
    }

    // Updates student information on the page.
    updateDisplay() {
        if (this.currentPage === 'mainInterface') {
            document.getElementById('displayStudentName').textContent = this.app.studentData.name || 'Student';
            document.getElementById('displayStudentGrade').textContent = (this.app.studentData.grade || 'K') + ' Grade';
        } else if (this.currentPage === 'summaryPage') {
            document.getElementById('summaryStudentName').textContent = this.app.studentData.name || 'Student';
            document.getElementById('sessionDate').textContent = `Session completed on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}`;
        }
    }

    // Starts the session timer.
    startSessionTimer() {
        this.sessionTimer = setInterval(() => {
            this.sessionDuration++;
            const minutes = Math.floor(this.sessionDuration / 60);
            const seconds = this.sessionDuration % 60;
            document.getElementById('sessionTimer').textContent = 
                `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);
    }

    // Stops the session timer.
    stopSessionTimer() {
        if (this.sessionTimer) {
            clearInterval(this.sessionTimer);
            this.sessionTimer = null;
        }
    }

    // Updates the microphone icon and state.
    updateMicrophoneState(state) {
        const microphoneBtn = document.getElementById('microphoneBtn');
        const micIcon = document.getElementById('micIcon');
        const voiceInstructions = document.getElementById('voiceInstructions');
        
        microphoneBtn.className = `microphone-button mic-${state}`;
        
        switch (state) {
            case 'listening':
                voiceInstructions.textContent = 'Listening... Speak now!';
                micIcon.innerHTML = `
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                `;
                break;
            case 'processing':
                voiceInstructions.textContent = 'Processing your response...';
                micIcon.innerHTML = `
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"/>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                `;
                break;
            default:
                voiceInstructions.textContent = 'Tap the microphone and start speaking';
                micIcon.innerHTML = `
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                `;
                break;
        }
    }

    // Updates the status text and indicator dot.
    updateStatus(type, message) {
        const statusText = document.getElementById('statusText');
        const statusDot = document.getElementById('statusDot');
        
        statusText.textContent = message;
        statusDot.className = 'status-dot';
        
        switch (type) {
            case 'listening':
                statusDot.style.background = 'var(--color-accent)';
                break;
            case 'processing':
                statusDot.style.background = 'var(--color-secondary)';
                break;
            case 'error':
                statusDot.style.background = 'var(--color-error)';
                break;
            default:
                statusDot.style.background = 'var(--color-success)';
                break;
        }
    }

    // Adds a caption to the captions container.
    addCaption(speaker, text) {
        const captionsContainer = document.getElementById('captionsContainer');
        const caption = document.createElement('div');
        caption.className = `caption caption-${speaker}`;
        caption.textContent = `${speaker === 'user' ? 'You' : 'AI Tutor'}: ${text}`;
        
        captionsContainer.appendChild(caption);
        
        while (captionsContainer.children.length > 3) {
            captionsContainer.removeChild(captionsContainer.firstChild);
        }
        
        setTimeout(() => {
            if (caption.parentNode) {
                caption.parentNode.removeChild(caption);
            }
        }, 10000);
    }
    
    // Shows a temporary message in the mascot's speech bubble.
    showMascotMessage(message) {
        const mascotBubble = document.getElementById('mascotBubble');
        const mascotText = document.getElementById('mascotText');
        
        mascotText.textContent = message;
        mascotBubble.classList.add('show');
        
        setTimeout(() => {
            mascotBubble.classList.remove('show');
        }, 3000);
    }

    // Shows a temporary notification pop-up.
    showNotification(message) {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 1rem;
            right: 1rem;
            background: var(--color-success-500);
            color: white;
            padding: 1rem 1.5rem;
            border-radius: 1rem;
            box-shadow: 0 8px 25px rgba(16, 185, 129, 0.3);
            z-index: 1000;
            transform: translateX(100%);
            transition: transform 0.3s ease;
            max-width: 300px;
        `;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.transform = 'translateX(0)';
        }, 100);
        
        setTimeout(() => {
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => {
                document.body.removeChild(notification);
            }, 300);
        }, 3000);
    }

    // Simulates a loading screen and transitions to the main interface.
    showLoadingAndTransition() {
        const startBtn = document.getElementById('startBtn');
        startBtn.innerHTML = `
            <span style="position: relative; z-index: 10; display: flex; align-items: center; justify-content: center;">
                <div class="loading-spinner"></div>
                Preparing your session...
            </span>
        `;
        
        setTimeout(() => {
            this.switchToPage('mainInterface');
            this.startSessionTimer();
        }, 2000);
    }
}