// main.js

import { AppManager } from './pages/app-manager.js';
import { NotesManager } from './pages/notes.js';
import { SessionManager } from './pages/session-manager.js';
import { SpeechManager } from './pages/speech.js';

class AITutorApp {
    constructor() {
        // Shared state that managers can access
        this.studentData = { name: '', grade: 'K' };

        // Initialize all the different managers
        this.appManager = new AppManager(this);
        this.notesManager = new NotesManager(this);
        this.sessionManager = new SessionManager(this);
        this.speechManager = new SpeechManager(this);
        
        // Final setup and event listeners
        this.setupMainEvents();
        this.sessionManager.loadSavedData();
    }
    
    setupMainEvents() {
        // Form submission for student data on the landing page
        document.getElementById('studentForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.studentData.name = document.getElementById('studentName').value;
            this.studentData.grade = document.getElementById('studentGrade').value;
            this.sessionManager.saveStudentData();
            this.appManager.showLoadingAndTransition();
        });
        
        // Start button on the landing page (if not using the form)
        document.getElementById('startBtn').addEventListener('click', () => {
            this.appManager.showLoadingAndTransition();
        });
        
        // Main interface buttons
        document.getElementById('microphoneBtn').addEventListener('click', () => this.speechManager.toggleVoiceRecognition());
        document.getElementById('readAloudBtn').addEventListener('click', () => this.speechManager.readAloud());
        document.getElementById('openNotesBtn').addEventListener('click', () => this.notesManager.openNotesPanel());
        document.getElementById('closeNotesBtn').addEventListener('click', () => this.notesManager.closeNotesPanel());
        document.getElementById('endSessionBtn').addEventListener('click', () => this.sessionManager.endSession());
        
        // Button on the summary page to go back home
        document.getElementById('backToHomeBtn').addEventListener('click', () => this.appManager.switchToPage('landingPage'));
    }
}

// Start the application when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new AITutorApp();
});