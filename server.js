const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path'); // Added for serving static files correctly

// --- Unified Configuration ---
const config = {
    PORT: process.env.PORT || 3000,
    SESSION_TTL: 45 * 60 * 1000,
    CLEANUP_INTERVAL: 5 * 60 * 1000,
    GPT_MODEL: 'gpt-4o-mini',
    GPT_TEMPERATURE: 0.7,
    VALID_GRADES: ['PreK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
    INAPPROPRIATE_TOPICS: ['breast', 'condom', 'erotic', 'intercourse', 'porn', 'sex', 'abuse', 'blood', 'bomb', 'death', 'gun', 'kill', 'murder', 'suicide', 'ass', 'fuck', 'shit', 'bitch', 'alcohol', 'drugs', 'cocaine', 'marijuana', 'dumb', 'stupid', 'hate', 'idiot'],
    SUBJECTS: {
        math: ['math', 'number', 'add', 'subtract', 'multiply', 'divide', 'count', 'fraction', 'algebra', 'geometry'],
        reading: ['read', 'book', 'story', 'word', 'phonics', 'vocabulary', 'comprehension', 'write'],
        science: ['science', 'animal', 'plant', 'space', 'weather', 'experiment', 'nature', 'biology', 'physics'],
        socialStudies: ['history', 'government', 'geography', 'culture', 'map', 'president', 'country'],
        art: ['art', 'draw', 'paint', 'color', 'creative', 'design'],
        music: ['music', 'song', 'sing', 'instrument', 'rhythm', 'melody']
    }
};

if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Missing OPENAI_API_KEY');
    process.exit(1);
}

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sessions = new Map();

// Middleware
app.use(cors(), express.json({ limit: '4kb' }), helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 60_000, max: 50, message: { error: 'Too many requests' } }));

// Cleanup expired sessions
setInterval(() => {
    const now = Date.now();
    for (const [id, sess] of sessions) {
        if (now - sess.lastActivity > config.SESSION_TTL) {
            console.log(`🧹 Cleaning up session ${id.slice(-6)}`);
            sessions.delete(id);
        }
    }
}, config.CLEANUP_INTERVAL);

// Utility functions
const containsInappropriate = (text) => {
    const lower = text.toLowerCase();
    return config.INAPPROPRIATE_TOPICS.some(word => new RegExp(`\\b${word}\\b`).test(lower));
};

const classifySubject = (input) => {
    const lower = input.toLowerCase();
    for (const [subject, keywords] of Object.entries(config.SUBJECTS)) {
        if (keywords.some(keyword => new RegExp(`\\b${keyword}\\b`).test(lower))) {
            return subject;
        }
    }
    return null;
};

const getMaxTokens = (grade) => {
    const level = parseInt(grade) || 0;
    return level <= 2 ? 50 : level <= 5 ? 75 : level <= 8 ? 100 : 125;
};

const getTutorPrompt = (grade, name) => {
    const responseLength = {
        'PreK': '1 sentence max', 'K': '1-2 sentences', '1': '1-2 sentences', '2': '2 sentences',
        '3': '2-3 sentences', '4': '2-3 sentences', '5': '3 sentences', '6': '3-4 sentences',
        '7': '3-4 sentences', '8': '3-4 sentences', '9': '4-5 sentences', '10': '4-5 sentences',
        '11': '4-5 sentences', '12': '4-5 sentences'
    };

    const readingInstruction = ['PreK', 'K', '1', '2'].includes(grade) ?
        'For reading activities, reply in JSON: {"message": "Can you read this word?", "READING_WORD": "cat"}' : '';

    return `You are an AI Tutor for ${name}. Teach students to THINK, not memorize!
- Keep responses ${responseLength[grade] || '2-3 sentences'}
- Use age-appropriate language
- Be encouraging and patient
- If wrong answer, gently correct and explain why
- Avoid inappropriate topics - redirect to learning
- Show step-by-step thinking
${readingInstruction}`;
};

const generateResponse = (type, name, grade) => {
    const responses = {
        welcome: {
            'PreK': `Hi ${name}! Let's learn!`, 'K': `Hello ${name}! What's fun today?`,
            '1': `Hi ${name}! Ready to learn?`, '2': `Hey ${name}! What should we explore?`,
            '3': `Hi ${name}! What interests you?`, '4': `Hello ${name}! What's on your mind?`,
            '5': `Hi ${name}! What would you like to learn?`, '6': `Hey ${name}! What interests you?`,
            '7': `Hi ${name}! What can we explore?`, '8': `Hello ${name}! What should we discover?`,
            '9': `Hi ${name}! What can I help with?`, '10': `Hey ${name}! What's your focus?`,
            '11': `Hello ${name}! What topic interests you?`, '12': `Hi ${name}! What can we explore?`
        },
        redirect: `I'm here to help you learn amazing things, ${name}! What would you like to explore today?`,
        encourage: [`Great job, ${name}!`, `You're doing amazing!`, `Keep thinking!`, `I love your curiosity!`],
        suggestions: {
            early: ['Let\'s count!', 'What about colors?', 'Animal sounds?'],
            middle: ['Try some math!', 'Read a story!', 'Explore science!'],
            high: ['Solve a problem!', 'Learn something new!', 'Dive deeper!']
        }
    };

    if (type === 'welcome') return responses.welcome[grade] || responses.welcome['K'];
    if (type === 'redirect') return responses.redirect;
    if (type === 'encourage') return responses.encourage[Math.floor(Math.random() * responses.encourage.length)];
    if (type === 'suggestions') {
        const level = parseInt(grade) <= 2 ? 'early' : parseInt(grade) <= 5 ? 'middle' : 'high';
        return responses.suggestions[level];
    }
};

const createSession = (id, name, grade, subjects) => ({
    id, studentName: name || 'Student', grade: grade || 'K', subjects: subjects || [],
    startTime: new Date(), lastActivity: Date.now(), totalWarnings: 0,
    messages: [{ role: 'system', content: getTutorPrompt(grade, name), timestamp: new Date() }],
    topicsDiscussed: new Set(), conversationContext: []
});

// --- API Routes (Existing Backend Logic) ---
app.post('/api/session/start', (req, res) => {
    try {
        const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
        const { studentName, grade, subjects } = req.body;

        const validatedGrade = config.VALID_GRADES.includes(grade) ? grade : 'K';
        const validatedName = studentName?.trim() || 'Student';

        const session = createSession(sessionId, validatedName, validatedGrade, subjects);
        sessions.set(sessionId, session);

        console.log(`🚀 Session started: ${sessionId.slice(-6)}, ${validatedName}, Grade: ${validatedGrade}`);

        res.json({
            sessionId,
            welcomeMessage: generateResponse('welcome', validatedName, validatedGrade),
            status: 'success',
            sessionInfo: { studentName: validatedName, grade: validatedGrade, startTime: session.startTime }
        });
    } catch (error) {
        console.error('❌ Error starting session:', error.message);
        res.status(500).json({ error: 'Failed to start session' });
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { sessionId, message } = req.body;

        if (!sessionId || !sessions.has(sessionId)) {
            return res.status(400).json({ error: 'Invalid session' });
        }

        if (!message?.trim()) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        const session = sessions.get(sessionId);
        session.lastActivity = Date.now();

        const cleanedMessage = message.trim();

        // Handle thinking pauses
        if (cleanedMessage.length < 3 || /^(um+|uh+|er+|hmm+)$/i.test(cleanedMessage)) {
            return res.json({
                response: `I'm listening, ${session.studentName}! Take your time.`,
                suggestions: ["Go ahead!", "I'm here!", "What were you thinking?"],
                status: 'listening'
            });
        }

        // Check for inappropriate content
        if (containsInappropriate(message)) {
            session.totalWarnings++;
            console.warn(`🚨 Inappropriate content in session ${sessionId.slice(-6)}`);
            return res.json({
                response: generateResponse('redirect', session.studentName),
                suggestions: generateResponse('suggestions', null, session.grade),
                status: 'redirected'
            });
        }

        // Add user message
        session.messages.push({ role: 'user', content: cleanedMessage, timestamp: new Date() });

        // Keep conversation manageable
        if (session.messages.length > 8) {
            session.messages = [session.messages[0], ...session.messages.slice(-7)];
        }

        // Generate AI response
        const completion = await openai.chat.completions.create({
            model: config.GPT_MODEL,
            messages: session.messages.map(m => ({ role: m.role, content: m.content })),
            max_tokens: getMaxTokens(session.grade),
            temperature: config.GPT_TEMPERATURE,
            stop: ["\n\n", "Additionally,", "Furthermore,"]
        });

        let aiResponse = completion.choices[0].message.content.trim();
        let readingWord = null;

        // Handle reading JSON format
        try {
            const parsed = JSON.parse(aiResponse);
            if (parsed.READING_WORD) {
                aiResponse = parsed.message;
                readingWord = parsed.READING_WORD;
            }
        } catch (e) { }

        // Check AI response for inappropriate content
        if (containsInappropriate(aiResponse)) {
            session.totalWarnings++;
            aiResponse = generateResponse('redirect', session.studentName);
        }

        // Add AI response to session
        session.messages.push({ role: 'assistant', content: aiResponse, timestamp: new Date() });

        // Track topics
        const subject = classifySubject(message);
        if (subject) session.topicsDiscussed.add(subject);

        // Update conversation context
        session.conversationContext.push(
            { role: 'user', message: cleanedMessage, topic: subject, timestamp: Date.now() },
            { role: 'assistant', message: aiResponse, topic: subject, timestamp: Date.now() }
        );

        if (session.conversationContext.length > 6) {
            session.conversationContext = session.conversationContext.slice(-6);
        }

        res.json({
            response: aiResponse,
            readingWord,
            subject,
            suggestions: generateResponse('suggestions', null, session.grade),
            encourage: generateResponse('encourage', session.studentName),
            status: 'success',
            sessionStats: {
                totalWarnings: session.totalWarnings,
                topicsDiscussed: Array.from(session.topicsDiscussed)
            }
        });

    } catch (error) {
        console.error('❌ Chat error:', error.message);
        res.status(500).json({
            error: 'Failed to process message',
            fallback: `I'm having trouble right now, but I'm here to help you learn!`
        });
    }
});

app.get('/api/session/:sessionId/summary', (req, res) => {
    try {
        const session = sessions.get(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        const duration = Math.floor((Date.now() - session.startTime.getTime()) / 60000);
        const topics = Array.from(session.topicsDiscussed);

        res.json({
            duration: duration > 0 ? `${duration} minutes` : 'Less than a minute',
            totalWarnings: session.totalWarnings,
            topicsExplored: topics.length ? `Explored: ${topics.join(', ')}` : 'General conversation',
            studentName: session.studentName,
            grade: session.grade,
            highlights: [`${session.studentName} engaged well in learning!`],
            suggestions: [`Keep practicing ${topics[0] || 'various topics'}!`],
            nextSteps: ['Continue exploring topics that interest you!']
        });
    } catch (error) {
        console.error('❌ Summary error:', error.message);
        res.status(500).json({ error: 'Failed to get summary' });
    }
});

app.post('/api/session/:sessionId/end', (req, res) => {
    try {
        const session = sessions.get(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        sessions.delete(req.params.sessionId);
        console.log(`🛑 Session ${req.params.sessionId.slice(-6)} ended`);

        res.json({ status: 'ended', message: 'Session closed successfully' });
    } catch (error) {
        console.error('❌ End session error:', error.message);
        res.status(500).json({ error: 'Failed to end session' });
    }
});

app.get('/api/session/:sessionId/status', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    res.json({
        active: true,
        duration: Math.floor((Date.now() - session.startTime.getTime()) / 60000),
        topics: Array.from(session.topicsDiscussed)
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date(),
        activeSessions: sessions.size,
        uptime: process.uptime()
    });
});

// --- Frontend JavaScript (Client-side code) as a string ---
const clientSideJs = `
// Consolidated state
const state = {
    listening: false,
    processing: false,
    sessionStarted: false,
    sessionId: null,
    recognition: null,
    synthesis: window.speechSynthesis,
    selectedVoice: null,
    chatHistory: [],
    currentSubject: null
};

// IMPORTANT: This URL is automatically set to the current host for the frontend calls.
const API_BASE_URL = window.location.origin + '/api';

// Utility functions
const $ = id => document.getElementById(id);
const updateStatus = msg => $('status').textContent = msg;
const showElement = id => $(id).classList.remove('hidden');
const hideElement = id => $(id).classList.add('hidden');
const addToHistory = (sender, message) => state.chatHistory.push({sender, message});

// Enhanced speech synthesis with better voice selection
async function initSpeech() {
    return new Promise(resolve => {
        const selectVoice = () => {
            const voices = state.synthesis.getVoices();
            const preferred = ['Samantha', 'Karen', 'Susan', 'Google UK English Female', 'Microsoft Zira'];

            state.selectedVoice = preferred.map(name =>
                voices.find(v => v.name.toLowerCase().includes(name.toLowerCase()))
            ).find(v => v) || voices.find(v => v.lang.startsWith('en')) || voices[0];

            resolve();
        };

        if (state.synthesis.getVoices().length > 0) {
            selectVoice();
        } else {
            state.synthesis.onvoiceschanged = selectVoice;
            setTimeout(selectVoice, 1000);
        }
    });
}

// Enhanced TTS with interruption handling
function speak(text, type = 'bot') {
    return new Promise(resolve => {
        if (state.synthesis.speaking) state.synthesis.cancel();

        setTimeout(() => {
            const utterance = new SpeechSynthesisUtterance(text);
            Object.assign(utterance, {
                rate: 0.8,
                pitch: 1.0,
                volume: 1.0,
                voice: state.selectedVoice
            });

            utterance.onstart = () => showCaption(text, type);
            utterance.onend = () => {
                hideElement('live-captions');
                if (state.sessionStarted && !state.listening) {
                    updateStatus("Listening for your response…");
                    startListening();
                }
                resolve();
            };
            utterance.onerror = resolve;

            state.synthesis.speak(utterance);
        }, 100);
    });
}

// Enhanced caption system
function showCaption(text, type = 'bot') {
    const caption = $('live-captions');
    caption.textContent = text;
    caption.className = \`live-captions \${type}-caption\`;
    showElement('live-captions');
    if (type === 'user') setTimeout(() => hideElement('live-captions'), 2000);
}

// Streamlined speech recognition
function initRecognition() {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
        updateStatus("Speech recognition not supported. Please use Chrome or Edge!");
        return false;
    }

    state.recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    Object.assign(state.recognition, {
        continuous: true,
        interimResults: true,
        lang: 'en-US',
        maxAlternatives: 1
    });

    state.recognition.onstart = () => {
        state.listening = true;
        updateStatus("I'm listening! Go ahead and speak.");
    };

    state.recognition.onend = () => state.listening = false;

    state.recognition.onresult = (event) => {
        // Grab the best result
        const result = event.results[event.resultIndex][0];
        const transcript = result.transcript.trim();
        const confidence = result.confidence;

        // Show the live caption
        const cap = $('live-captions');
        cap.textContent = transcript;
        cap.classList.remove('hidden');

        // Only act on final results that are likely real speech
        if (event.results[event.resultIndex].isFinal && !state.processing) {
            // Filter out low-confidence or too-short snippets
            const isNoise = confidence < 0.7 || transcript.length < 3 || /^(um+|uh+|er+|hmm+)$/i.test(transcript);
            if (isNoise) {
                updateStatus("Sorry, I didn't catch that. Please try again.");
            } else {
                // If the tutor is still speaking, cut them off
                if (state.synthesis.speaking) {
                    state.synthesis.cancel();
                }
                handleUserInput(transcript);
            }

            // Hide caption after a brief moment
            setTimeout(() => cap.classList.add('hidden'), 600);
        }
    };

    state.recognition.onerror = event => {
        state.processing = false;
        const errorMsg = {
            'no-speech': "I didn't hear anything. Please try again.",
            'audio-capture': "Couldn't access microphone. Check permissions.",
            'not-allowed': "Microphone access denied. Please enable it.",
            'network': "Network error. Check your connection.",
            'service-not-allowed': "Browser doesn't support speech recognition. Try Chrome."
        }[event.error] || "Please try speaking again!";

        updateStatus(errorMsg);
    };

    return true;
}

function startListening() {
    if (state.recognition && !state.listening && !state.processing) {
        try { state.recognition.start(); }
        catch (e) { console.warn('Recognition start error:', e); }
    }
}

// Enhanced reading word display
function showReadingWord(prompt, word) {
    const container = $('reading-word-container');
    const wordDisplay = $('reading-word');

    wordDisplay.innerHTML = \`
        <div style="font-size: 1.4rem; margin-bottom: 1rem; font-weight: bold;">\${prompt}</div>
        <div>\${word}</div>
    \`;

    showElement('reading-word-container');
}

// Streamlined user input handling
async function handleUserInput(input) {
    if (state.processing || !state.sessionStarted) return;

    state.processing = true;
    updateStatus("Processing your request...");
    addToHistory('user', input);

    try {
        const response = await fetch(\`\${API_BASE_URL}/chat\`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                sessionId: state.sessionId,
                message: input,
                context: {}
            })
        });

        if (!response.ok) throw new Error('API request failed');

        const data = await response.json();

        // Handle reading word display
        if (data.readingWord) {
            showReadingWord(data.response, data.readingWord);
            await speak(data.response);
            addToHistory('tutor', data.response + ' (See word above)');
        } else {
            hideElement('reading-word-container');
            await speak(data.response);
            addToHistory('tutor', data.response);
        }

        if (data.subject) state.currentSubject = data.subject;
        updateSuggestions(input, data.response);

    } catch (error) {
        console.error('Error:', error);
        // Using the fallback from the backend if provided, otherwise a generic one.
        const fallback = error.fallback || "Oops! Something went wrong on my end. Can you please try asking in a different way?";
        addToHistory('tutor', fallback);
        await speak(fallback);
    } finally {
        state.processing = false;
        updateStatus("Ready for your next question!");
    }
}

// Smart suggestion system
function updateSuggestions(userInput, tutorResponse) {
    const combined = (userInput + ' ' + tutorResponse).toLowerCase();
    const grid = $('suggestion-grid');

    const suggestionSets = {
        math: [
            {text: '🔢 More math problems', query: 'Give me another math problem'},
            {text: '📊 Explain this concept', query: 'Explain this math topic more'},
            {text: '🎲 Math games', query: 'Let\\\\\\'s play a math game'},
            {text: '🧮 Real-world math', query: 'How is this used in real life?'}
        ],
        reading: [
            {text: '📖 Read together', query: 'Can we read something together?'},
            {text: '📝 New vocabulary', query: 'Teach me new words'},
            {text: '✍️ Write a story', query: 'Help me write a story'},
            {text: '🎭 Act it out', query: 'Can we act out this story?'}
        ],
        science: [
            {text: '🔬 Try experiment', query: 'Can we do a science experiment?'},
            {text: '🌟 Learn about space', query: 'Tell me about space'},
            {text: '🐾 Explore animals', query: 'I want to learn about animals'},
            {text: '🌱 Discover plants', query: 'Tell me about plants'}
        ],
        default: [
            {text: '❓ Ask anything', query: 'I have a question'},
            {text: '🎯 New topic', query: 'What should we learn next?'},
            {text: '🔍 Explore more', query: 'Tell me more about this'},
            {text: '🎉 Something fun', query: 'Let\\\\\\'s do something fun'}
        ]
    };

    // Determine which set of suggestions to show based on recent conversation
    const selectedSetKey = Object.keys(suggestionSets).find(key =>
        combined.includes(key) || (key !== 'default' && combined.includes(key.slice(0, -1)))
    ) || 'default';

    grid.innerHTML = suggestionSets[selectedSetKey].map(s =>
        \`<div class="suggestion-item" onclick="handleUserInput('\${s.query.replace(/'/g, "\\\\'")}')">\${s.text}</div>\`
    ).join('');
}


// Session management - exposed globally for HTML \`onclick\`
window.startTutoring = async function() {
    await initSpeech();

    if (!initRecognition()) return;

    const name = $('student-name').value.trim() || 'Student';
    const grade = $('student-grade').value || 'K';

    try {
        updateStatus("Starting session...");

        const response = await fetch(\`\${API_BASE_URL}/session/start\`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({studentName: name, grade, subjects: []})
        });

        if (!response.ok) throw new Error('Session start failed');

        const data = await response.json();
        state.sessionId = data.sessionId;
        state.sessionStarted = true;

        hideElement('welcome-screen');
        showElement('tutor-interface');

        const welcome = data.welcomeMessage || \`Hi \${name}! I'm excited to learn with you today. What shall we explore?\`;
        await speak(welcome);
        addToHistory('tutor', welcome);

        updateSuggestions('', welcome);
        startListening();
    } catch (error) {
        console.error('Session start error:', error);
        alert("Failed to start session. Please try again. Check console for details.");
    }
}

window.endSession = async function() {
    state.synthesis.cancel();
    if (state.listening) state.recognition.stop();

    try {
        const [summaryRes] = await Promise.all([
            fetch(\`\${API_BASE_URL}/session/\${state.sessionId}/summary\`),
            fetch(\`\${API_BASE_URL}/session/\${state.sessionId}/end\`, {method: 'POST'})
        ]);

        const summary = summaryRes.ok ? await summaryRes.json() : null;
        showSessionSummary(summary);
    } catch (error) {
        console.error('End session error:', error);
        showSessionSummary(null);
    }
}

function showSessionSummary(summary) {
    hideElement('tutor-interface');
    showElement('session-summary');

    const content = $('summary-content');

    if (summary) {
        const suggestions = [
            ...(Array.isArray(summary.suggestions) ? summary.suggestions : [summary.suggestions]),
            ...(Array.isArray(summary.nextSteps) ? summary.nextSteps : [summary.nextSteps])
        ].filter(Boolean);

        content.innerHTML = \`
            <div><strong>Duration:</strong> \${summary.duration}</div>
            <div><strong>Topics:</strong> \${summary.topicsExplored}</div>
            <div><strong>Highlights:</strong><br>\${Array.isArray(summary.highlights) ? summary.highlights.join('<br>') : summary.highlights || 'No specific highlights.'}</div>
            <div><strong>Next Steps:</strong><br>\${suggestions.length ? suggestions.join('<br>') : 'Keep asking great questions!'}</div>
        \`;
    } else {
        content.innerHTML = '<div><strong>Session Complete!</strong> You had a wonderful learning session today!</div>';
    }

    speak("You had a wonderful learning session today! Keep being curious!");
}

window.startNewSession = function() {
    state.synthesis.cancel();
    if (state.recognition && state.listening) state.recognition.stop();

    Object.assign(state, {
        sessionId: null,
        processing: false,
        sessionStarted: false,
        listening: false,
        chatHistory: [],
        currentSubject: null,
        recognition: null
    });

    hideElement('session-summary');
    hideElement('tutor-interface');
    hideElement('reading-word-container');
    hideElement('live-captions');
    showElement('welcome-screen');

    $('student-name').value = '';
    $('student-grade').value = '';

    updateStatus("Ready to start a new session!");
    initRecognition();
    initSpeech();
    updateSuggestions('', 'Welcome');
}

// History management - exposed globally for HTML \`onclick\`
window.showHistory = function() {
    $('full-chat-history').innerHTML = state.chatHistory.map(msg =>
        \`<div class="chat-message \${msg.sender}-message">
            <strong>\${msg.sender === 'tutor' ? 'Tutor' : 'You'}:</strong> \${msg.message}
        </div>\`
    ).join('');
    showElement('chat-history-modal');
}

window.closeHistory = function() {
    hideElement('chat-history-modal');
}

// Initialize on load
window.onload = async function() {
    console.log('🚀 AI Tutor loading...');
    await initSpeech();
    initRecognition();
    updateSuggestions('', 'Welcome');
    console.log('✅ AI Tutor ready!');
};
`;

// --- New Route for serving HTML with embedded JS ---
app.get('/', (req, res) => {
    // We're essentially building the HTML string here and embedding the JS string.
    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Tutor</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            color: white;
            padding: 1rem;
        }
        .container { text-align: center; max-width: 800px; width: 100%; padding: 1rem; }
        .mascot { font-size: 4rem; margin-bottom: 1rem; animation: float 3s ease-in-out infinite; }
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
        h1 { font-size: 2.5rem; margin-bottom: 1rem; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
        h2 { font-size: 2rem; margin-bottom: 1rem; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
        
        .glass-panel {
            background: rgba(255,255,255,0.1);
            padding: 2rem;
            border-radius: 15px;
            margin: 2rem 0;
            backdrop-filter: blur(10px);
        }
        
        .form-group {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 0.5rem;
            margin-bottom: 1rem;
        }
        
        .form-group label { font-weight: bold; font-size: 1.1rem; }
        .form-group input, .form-group select {
            background: rgba(255,255,255,0.2);
            border: none;
            border-radius: 10px;
            padding: 0.75rem 1rem;
            color: white;
            font-size: 1rem;
            width: 100%;
            max-width: 300px;
        }
        
        .form-group input::placeholder { color: rgba(255,255,255,0.7); }
        .form-group select, .form-group select option { background: #764ba2; color: white; }
        
        .btn {
            border: none;
            border-radius: 25px;
            padding: 1rem 2rem;
            font-size: 1.2rem;
            font-weight: bold;
            color: white;
            cursor: pointer;
            transition: all 0.3s ease;
            font-family: inherit;
            margin: 1rem;
        }
        
        .btn-primary {
            background: linear-gradient(45deg, #4CAF50, #45a049);
            box-shadow: 0 8px 16px rgba(0,0,0,0.3);
        }
        
        .btn-danger { background: linear-gradient(45deg, #f44336, #d32f2f); }
        .btn-warning { background: linear-gradient(45deg, #ffcc00, #ffa500); color: #333; }
        .btn:hover { transform: translateY(-2px); }
        
        .status {
            font-size: 1.2rem;
            margin: 1rem 0;
            min-height: 3rem;
            padding: 1rem;
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .suggestions h3 { margin-bottom: 1rem; font-size: 1.3rem; }
        .suggestion-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 0.5rem;
            margin-top: 1rem;
        }
        
        .suggestion-item {
            background: rgba(255,255,255,0.2);
            padding: 0.75rem 1rem;
            border-radius: 20px;
            cursor: pointer;
            transition: all 0.3s ease;
            border: 2px solid transparent;
            text-align: center;
            font-size: 0.9rem;
        }
        
        .suggestion-item:hover {
            background: rgba(255,255,255,0.3);
            transform: translateY(-2px);
            border-color: rgba(255,255,255,0.5);
        }
        
        .live-captions {
            position: fixed;
            bottom: 8vh;
            left: 50%;
            transform: translateX(-50%);
            min-width: 220px;
            max-width: 90vw;
            background: rgba(0,0,0,0.7);
            color: #fff;
            font-size: 1.3rem;
            padding: 1.1rem 2rem;
            border-radius: 30px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.2);
            text-align: center;
            z-index: 100;
            opacity: 0.97;
            transition: opacity 0.3s;
            pointer-events: none;
        }
        
        .live-captions.user-caption { background: rgba(56, 183, 74, 0.88); border: 2px solid #2ecc40; }
        .live-captions.bot-caption { background: rgba(52, 152, 219, 0.88); border: 2px solid #2980b9; }
        
        .modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(0,0,0,0.55);
            z-index: 9999;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .modal-content {
            background: #fff;
            color: #333;
            border-radius: 16px;
            padding: 2rem;
            width: 95vw;
            max-width: 600px;
            max-height: 85vh;
            overflow-y: auto;
            box-shadow: 0 10px 32px rgba(0,0,0,0.3);
            position: relative;
        }
        
        .close-btn {
            position: absolute;
            top: 14px;
            right: 18px;
            background: none;
            border: none;
            font-size: 2rem;
            color: #888;
            cursor: pointer;
        }
        
        .close-btn:hover { color: #f44336; }
        
        .chat-message {
            margin: 0.5rem 0;
            padding: 0.5rem 1rem;
            border-radius: 10px;
            text-align: left;
            font-size: 0.9rem;
        }
        
        .user-message { background: rgba(76, 175, 80, 0.2); margin-left: 1rem; }
        .tutor-message { background: rgba(33, 150, 243, 0.2); margin-right: 1rem; }
        .hidden { display: none; }
        
        .reading-word-display {
            font-size: 3.2rem;
            letter-spacing: 0.15em;
            background: linear-gradient(90deg,#fff8,#fffb);
            color: #764ba2;
            padding: 1.1rem 3.4rem;
            border-radius: 1.1em;
            box-shadow: 0 4px 30px rgba(33,150,243,0.18);
            font-weight: 900;
            border: 3px solid #eee;
            margin: 1rem 0;
        }
        
        @media (max-width: 768px) {
            .suggestion-grid { grid-template-columns: 1fr; }
            h1 { font-size: 2rem; }
            h2 { font-size: 1.5rem; }
            .btn { padding: 0.75rem 1.5rem; font-size: 1rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div id="welcome-screen">
            <div class="mascot">🎓</div>
            <h1>Hi! I'm your AI Tutor!</h1>
            <p style="font-size: 1.2rem; margin-bottom: 2rem;">Ready to learn and explore together?</p>
            
            <div class="glass-panel">
                <div class="form-group">
                    <label for="student-name">Name</label>
                    <input type="text" id="student-name" placeholder="What's your name?" maxlength="50" />
                </div>
                
                <div class="form-group">
                    <label for="student-grade">Grade</label>
                    <select id="student-grade">
                        <option value="">Select your grade</option>
                        <option value="PreK">Pre-K</option>
                        <option value="K">Kindergarten</option>
                        <option value="1">1st Grade</option>
                        <option value="2">2nd Grade</option>
                        <option value="3">3rd Grade</option>
                        <option value="4">4th Grade</option>
                        <option value="5">5th Grade</option>
                        <option value="6">6th Grade</option>
                        <option value="7">7th Grade</option>
                        <option value="8">8th Grade</option>
                        <option value="9">9th Grade</option>
                        <option value="10">10th Grade</option>
                        <option value="11">11th Grade</option>
                        <option value="12">12th Grade</option>
                    </select>
                </div>
                
                <button class="btn btn-primary" onclick="startTutoring()">Start Learning!</button>
            </div>
        </div>

        <div id="tutor-interface" class="hidden">
            <div class="mascot">🤖</div>
            <h2>Let's Learn Together!</h2>
            
            <div class="glass-panel status" id="status">Click the mic or tap suggestions to start!</div>
            
            <div id="reading-word-container" class="hidden">
                <div class="reading-word-display" id="reading-word"></div>
            </div>
            
            <div class="glass-panel suggestions">
                <h3>🎯 What sounds fun today?</h3>
                <div class="suggestion-grid" id="suggestion-grid"></div>
            </div>
            
            <button class="btn btn-warning" onclick="showHistory()">View Chat History</button>
            <button class="btn btn-danger" onclick="endSession()">End Session</button>
        </div>

        <div id="session-summary" class="glass-panel hidden">
            <h2>Session Complete! 🎉</h2>
            <div id="summary-content"></div>
            <button class="btn btn-primary" onclick="startNewSession()">Start New Session</button>
        </div>

        <div id="live-captions" class="live-captions hidden" aria-live="polite"></div>

        <div id="chat-history-modal" class="modal hidden">
            <div class="modal-content">
                <button onclick="closeHistory()" class="close-btn">&times;</button>
                <h3>Chat History</h3>
                <div id="full-chat-history"></div>
            </div>
        </div>
    </div>
    <script>
        ${clientSideJs}
    </script>
</body>
</html>
`;
    res.send(htmlContent);
});


// Start server
const server = app.listen(config.PORT, () => {
    console.log(`🎓 AI Tutor Backend running on port ${config.PORT}`);
    console.log(`🌐 Frontend available at http://localhost:${config.PORT}/`);
    console.log(`🚀 Ready to help students learn safely!`);
});

// Graceful shutdown
['SIGTERM', 'SIGINT'].forEach(signal => {
    process.on(signal, () => {
        console.log(`Received ${signal}, shutting down...`);
        server.close(() => process.exit(0));
    });
});

module.exports = app;