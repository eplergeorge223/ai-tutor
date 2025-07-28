// pages/session-manager.js

export class SessionManager {
    constructor(appInstance) {
        this.app = appInstance; // Reference to the main application
    }

    // Loads student data and app settings from localStorage.
    loadSavedData() {
        const savedStudentData = localStorage.getItem('aiTutorStudentData');
        if (savedStudentData) {
            this.app.studentData = JSON.parse(savedStudentData);
        }
        
        // This method also handles the initial theme and font setup
        this.initializeTheme();
        this.initializeFonts();
    }
    
    // Saves student data to localStorage.
    saveStudentData() {
        localStorage.setItem('aiTutorStudentData', JSON.stringify(this.app.studentData));
        this.app.appManager.showNotification('Student data saved!');
    }

    // Handles the end of a session, generating a summary and switching pages.
    endSession() {
        if (!confirm('Are you sure you want to end the session?')) {
            return;
        }
        
        this.app.appManager.stopSessionTimer();
        this.generateSummaryReport();
        this.app.appManager.switchToPage('summaryPage');
    }

    // Generates a summary report and updates the summary page's UI.
    generateSummaryReport() {
        const totalDuration = this.app.appManager.sessionDuration;
        const minutes = Math.floor(totalDuration / 60);
        const seconds = totalDuration % 60;
        
        document.getElementById('summaryDuration').textContent = `
            ${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}
        `;
        
        // Placeholder for more detailed report data
        document.getElementById('summaryReportContent').innerHTML = `
            <p>You practiced with a variety of words and sounds.</p>
            <p>Great progress was made today!</p>
        `;
    }

    // Initializes the app's theme based on user preferences.
    initializeTheme() {
        const savedTheme = localStorage.getItem('aiTutorTheme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
    }
    
    // Initializes the app's fonts based on user preferences.
    initializeFonts() {
        const savedFont = localStorage.getItem('aiTutorFont') || 'sans-serif';
        document.documentElement.style.setProperty('--font-family-body', savedFont);
    }
}