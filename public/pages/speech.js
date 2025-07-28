// pages/speech.js

export class SpeechManager {
    constructor(appInstance) {
        // We need a reference to the main app instance to call its UI update methods.
        this.app = appInstance;
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.isListening = false;
        this.isProcessing = false;

        this.initializeSpeechRecognition();
    }

    // Initializes the browser's speech recognition and sets up its events.
    initializeSpeechRecognition() {
        if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            this.recognition = new SpeechRecognition();
            this.recognition.continuous = false;
            this.recognition.interimResults = true;
            this.recognition.lang = 'en-US';
            
            this.recognition.onstart = () => {
                this.isListening = true;
                this.app.updateMicrophoneState('listening');
                this.app.updateStatus('listening', 'Listening...');
                this.app.showMascotMessage("I'm listening! 👂");
            };
            
            this.recognition.onresult = (event) => {
                let finalTranscript = '';
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const transcript = event.results[i][0].transcript;
                    if (event.results[i].isFinal) {
                        finalTranscript += transcript;
                    }
                }
                
                if (finalTranscript) {
                    this.app.addCaption('user', finalTranscript);
                    this.processUserInput(finalTranscript);
                }
            };
            
            this.recognition.onerror = (event) => {
                console.error('Speech recognition error:', event.error);
                this.app.updateMicrophoneState('idle');
                this.app.updateStatus('error', 'Speech recognition error');
                this.app.showMascotMessage("Oops! Try again! 🔄");
            };
            
            this.recognition.onend = () => {
                this.isListening = false;
                if (!this.isProcessing) {
                    this.app.updateMicrophoneState('idle');
                    this.app.updateStatus('ready', 'Ready to learn');
                }
            };
        } else {
            console.warn('Speech recognition not supported');
            this.app.updateStatus('error', 'Speech recognition not supported');
        }
    }

    // Toggles the speech recognition on and off.
    toggleVoiceRecognition() {
        if (!this.recognition) {
            this.app.showNotification('Speech recognition is not supported in your browser.');
            return;
        }
        
        if (this.isListening) {
            this.recognition.stop();
        } else if (!this.isProcessing) {
            this.recognition.start();
        }
    }

    // Processes the user's spoken input.
    processUserInput(input) {
        this.isProcessing = true;
        this.app.updateMicrophoneState('processing');
        this.app.updateStatus('processing', 'Processing...');
        
        // Simulate AI processing delay
        setTimeout(() => {
            const response = this.generateAIResponse(input);
            this.app.addCaption('ai', response);
            this.speakResponse(response);
            
            this.isProcessing = false;
            this.app.updateMicrophoneState('idle');
            this.app.updateStatus('ready', 'Ready to learn');
            this.app.showMascotMessage(this.getRandomEncouragement());
        }, 1500);
    }

    // Generates a simple AI response based on the input.
    generateAIResponse(input) {
        const responses = [
            "Great job! Let's practice that word again.",
            `I heard you say '${input}'. That's wonderful!`,
            "You're doing amazing! Can you try reading the next word?",
            "Perfect pronunciation! Let's move on to the next challenge.",
            "I love how you're learning! Keep up the great work!"
        ];
        return responses[Math.floor(Math.random() * responses.length)];
    }

    // Speaks the provided text using text-to-speech.
    speakResponse(text) {
        if (this.synthesis) {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 0.9;
            utterance.pitch = 1.1;
            utterance.volume = 0.8;
            this.synthesis.speak(utterance);
        }
    }

    // Reads the main prompt text aloud.
    readAloud() {
        const promptText = document.querySelector('.prompt-text').textContent;
        if (this.synthesis) {
            const utterance = new SpeechSynthesisUtterance(promptText);
            utterance.rate = 0.8;
            utterance.pitch = 1.0;
            this.synthesis.speak(utterance);
            this.app.showMascotMessage("Listen carefully! 👂");
        }
    }
    
    // Provides a random encouraging message.
    getRandomEncouragement() {
        const encouragements = [
            "You're doing great! 🌟",
            "Keep it up! 👏",
            "Awesome work! 🎉",
            "You're a star! ⭐",
            "Fantastic! 🚀",
            "Well done! 💫"
        ];
        return encouragements[Math.floor(Math.random() * encouragements.length)];
    }
}