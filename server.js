const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OpenAI API Key in .env');
  process.exit(1);
}


const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting - more generous for educational use
app.use(rateLimit({
  windowMs: 60_000,
  max: 50, // Increased for active learning sessions
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
}));

app.use(express.static('public'));

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Store conversation history for each session
const sessions = new Map();

// Sessions expire after 45 minutes of inactivity
const SESSION_TTL = 45 * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;

// Cleanup expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.lastActivity > SESSION_TTL) {
      console.log(`Cleaning up expired session: ${id}`);
      sessions.delete(id);
    }
  }
}, CLEANUP_INTERVAL);

// Generate session ID
function generateSessionId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Enhanced AI Tutor system prompt with grade-specific adaptations
function getTutorSystemPrompt(grade, studentName) {
    const basePrompt = `You are ${studentName}'s AI Tutor, a friendly, encouraging, and knowledgeable educational assistant. Your personality should be:

- Warm, patient, and encouraging
- Age-appropriate in language and explanations
- Curious and enthusiastic about learning
- Supportive when students struggle
- Celebratory of achievements and progress

Guidelines:
- Ask follow-up questions to gauge understanding
- Break complex topics into simple, digestible parts
- Use analogies and examples kids can relate to
- Encourage critical thinking with gentle prompts
- Adapt your explanations based on the student's responses
- Keep responses conversational and engaging
- Always be positive and supportive
- DO NOT use emojis in your responses as they will be read aloud by text-to-speech
- Remember previous topics discussed in this session`;

    // Grade-specific adaptations
    const gradeSpecific = {
        'PreK': 'Use very simple language, focus on basic concepts, use lots of encouragement. Responses should be 1-2 sentences.',
        'K': 'Use simple words, focus on letters, numbers 1-10, colors, shapes. Keep responses short and playful.',
        '1': 'Focus on basic reading, simple addition/subtraction, encourage sounding out words. 1-2 sentences.',
        '2': 'Build on phonics, simple sentences, numbers to 100, basic science concepts. 2-3 sentences.',
        '3': 'More complex reading, multiplication tables, longer explanations. 2-3 sentences.',
        '4': 'Introduction to fractions, more complex stories, science experiments. 2-4 sentences.',
        '5': 'Decimals, more advanced reading comprehension, detailed explanations. 3-4 sentences.',
        '6': 'Pre-algebra concepts, research skills, critical thinking. 3-5 sentences.',
        '7': 'Algebra basics, more complex writing, scientific method. 3-5 sentences.',
        '8': 'Advanced algebra, essay writing, complex problem solving. 4-6 sentences.',
        '9': 'High school concepts, independent thinking, career exploration. 4-6 sentences.',
        '10': 'Advanced topics, college preparation, abstract thinking. 4-7 sentences.',
        '11': 'College-level concepts, research skills, critical analysis. 5-8 sentences.',
        '12': 'Advanced academic work, career preparation, complex projects. 5-8 sentences.'
    };

    const gradeGuideline = gradeSpecific[grade] || gradeSpecific['K'];
    
    return `${basePrompt}\n\nGrade-specific guidance: ${gradeGuideline}\n\nRemember: You're not just answering questions, you're fostering a love of learning!`;
}

// Enhanced session structure
function createSession(sessionId, studentName, grade, subjects) {
    return {
        id: sessionId,
        studentName: studentName || 'Student',
        grade: grade || 'K',
        subjects: subjects || [],
        startTime: new Date(),
        lastActivity: Date.now(),
        messages: [],
        totalInteractions: 0,
        topicsDiscussed: new Set(),
        achievements: [],
        strugglingAreas: [],
        preferredLearningStyle: null,
        sessionNotes: []
    };
}

// Routes

// Start new tutoring session
app.post('/api/session/start', async (req, res) => {
    try {
        const sessionId = generateSessionId();
        const { studentName, grade, subjects } = req.body;
        
        // Validate inputs
        const validGrades = ['PreK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
        const validatedGrade = validGrades.includes(grade) ? grade : 'K';
        const validatedName = studentName && studentName.trim() ? studentName.trim() : 'Student';
        
        const session = createSession(sessionId, validatedName, validatedGrade, subjects);
        sessions.set(sessionId, session);

        // Generate personalized welcome message
        const welcomeText = generateWelcomeMessage(validatedName, validatedGrade);

    console.log(`Started session ending in ${sessionId.slice(-6)} (Grade: ${validatedGrade})`);


        res.json({
            sessionId,
            welcomeMessage: welcomeText,
            status: 'success',
            sessionInfo: {
                studentName: validatedName,
                grade: validatedGrade,
                startTime: session.startTime
            }
        });
    } catch (error) {
        console.error('Error starting session:', error);
        res.status(500).json({ error: 'Failed to start session' });
    }
});

// Generate welcome message based on grade
function generateWelcomeMessage(studentName, grade) {
    const gradeMessages = {
        'PreK': `Hi ${studentName}! I'm your learning friend! Let's have fun together!`,
        'K': `Hello ${studentName}! I'm here to help you learn cool new things! What sounds fun today?`,
        '1': `Hi ${studentName}! I'm your AI tutor and I love learning with first graders! What would you like to explore?`,
        '2': `Hey ${studentName}! Ready for some awesome learning adventures? I'm here to help!`,
        '3': `Hi ${studentName}! Third grade is such an exciting time to learn! What are you curious about?`,
        '4': `Hello ${studentName}! I'm your AI tutor and I'm excited to tackle some fourth-grade challenges with you!`,
        '5': `Hi ${studentName}! Fifth grade brings so many interesting topics! What would you like to dive into?`,
        '6': `Hey ${studentName}! Middle school is full of fascinating subjects! What's on your mind today?`,
        '7': `Hi ${studentName}! Seventh grade opens up so many new learning opportunities! What interests you?`,
        '8': `Hello ${studentName}! Eighth grade is perfect for exploring complex ideas! What would you like to discover?`,
        '9': `Hi ${studentName}! High school brings exciting challenges! What subject can I help you with today?`,
        '10': `Hey ${studentName}! Sophomore year is great for building strong foundations! What's your focus?`,
        '11': `Hello ${studentName}! Junior year is crucial for growth! What topic would you like to master?`,
        '12': `Hi ${studentName}! Senior year - let's make it count! What can I help you achieve today?`
    };

    return gradeMessages[grade] || gradeMessages['K'];
}

// Enhanced chat endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { sessionId, message, context } = req.body;
        
        if (!sessionId || !sessions.has(sessionId)) {
            return res.status(400).json({ error: 'Invalid or expired session' });
        }

        if (!message || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }

        const session = sessions.get(sessionId);
        session.lastActivity = Date.now();

        if (session.totalInteractions >= 100) {
  return res.status(429).json({ error: 'Session limit reached. Please start a new session.' });
}


        const response = await generateAIResponse(sessionId, message.trim(), context);
        
        // Track topics and learning patterns
        const subject = classifySubject(message);
        if (subject) {
            session.topicsDiscussed.add(subject);
        }

        res.json({
            response: response.text,
            subject: response.subject,
            suggestions: response.suggestions,
            encouragement: response.encouragement,
            status: 'success',
            sessionStats: {
                totalInteractions: session.totalInteractions,
                topicsDiscussed: Array.from(session.topicsDiscussed)
            }
        });
    } catch (error) {
        console.error('Error processing chat:', error);
const fallback = generateFallbackResponse(message || '');
res.status(500).json({ 
    error: 'Failed to process message',
    fallback
});

    }
});

// Get session summary with enhanced details
app.get('/api/session/:sessionId/summary', (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = sessions.get(sessionId);
        
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const duration = Math.floor((Date.now() - session.startTime.getTime()) / 60000);
        const topics = Array.from(session.topicsDiscussed);
        
        // Generate learning highlights based on interaction
        const highlights = generateLearningHighlights(session);
        const recommendations = generateRecommendations(session);

        const summary = {
            duration: duration > 0 ? `${duration} minutes` : 'Less than a minute',
            totalInteractions: session.totalInteractions,
            topicsExplored: topics.length > 0 ? topics.join(', ') : 'General conversation',
            studentName: session.studentName,
            grade: session.grade,
            highlights: highlights,
            recommendations: recommendations,
            achievements: session.achievements,
            nextSteps: generateNextSteps(session)
        };

        console.log(`Generated summary for session ${sessionId}: ${duration} minutes, ${session.totalInteractions} interactions`);

        res.json(summary);
    } catch (error) {
        console.error('Error getting summary:', error);
        res.status(500).json({ error: 'Failed to get session summary' });
    }
});

app.post('/api/session/:sessionId/end', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    sessions.delete(sessionId);
    console.log(`Session ${sessionId.slice(-6)} ended by user`);

    res.json({ status: 'ended', message: 'Session successfully closed' });
});

// Generate learning highlights based on session data
function generateLearningHighlights(session) {
    const highlights = [];
    
    if (session.totalInteractions >= 10) {
        highlights.push('Had an engaged and lengthy learning conversation');
    } else if (session.totalInteractions >= 5) {
        highlights.push('Participated actively in the learning discussion');
    } else {
        highlights.push('Started exploring new learning topics');
    }

    if (session.topicsDiscussed.size > 1) {
        highlights.push(`Explored multiple subjects: ${Array.from(session.topicsDiscussed).join(', ')}`);
    }

    if (session.achievements.length > 0) {
        highlights.push(...session.achievements);
    } else {
        highlights.push('Showed curiosity and asked thoughtful questions');
    }

    return highlights;
}

// Generate personalized recommendations
function generateRecommendations(session) {
    const topics = Array.from(session.topicsDiscussed);
    
    if (topics.length === 0) {
        return `Continue exploring topics that spark your curiosity, ${session.studentName}!`;
    }

    const recommendations = [];
    
    if (topics.includes('math')) {
        recommendations.push('Practice math problems regularly to build confidence');
    }
    if (topics.includes('reading')) {
        recommendations.push('Keep reading different types of books to expand vocabulary');
    }
    if (topics.includes('science')) {
        recommendations.push('Try simple science experiments at home');
    }

    return recommendations.length > 0 
        ? recommendations.join('. ') + '.'
        : `Great job exploring ${topics.join(' and ')}, ${session.studentName}! Keep asking questions and staying curious.`;
}

// Generate next steps for continued learning
function generateNextSteps(session) {
    const steps = [
        'Continue asking questions about topics that interest you',
        'Try to connect what you learn to things you see in everyday life',
        'Share what you\'ve learned with family or friends'
    ];

    if (session.topicsDiscussed.has('math')) {
        steps.push('Practice math concepts with real-world examples');
    }
    if (session.topicsDiscussed.has('reading')) {
        steps.push('Read for at least 15 minutes each day');
    }

    return steps.slice(0, 3); // Return top 3 steps
}

// Enhanced AI response generation
async function generateAIResponse(sessionId, userMessage, context = {}) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    // Add user message to session
    session.messages.push({
        role: 'user',
        content: userMessage,
        timestamp: new Date()
    });
    session.totalInteractions++;

    // Prepare conversation history with context
    const systemPrompt = getTutorSystemPrompt(session.grade, session.studentName);
    const conversationHistory = session.messages.filter(m => m.role !== 'system').slice(-8);


    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory.map(msg => ({
            role: msg.role,
            content: msg.content
        }))
    ];

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: messages,
            max_tokens: 200,
            temperature: 0.7,
            presence_penalty: 0.1,
            frequency_penalty: 0.1
        });

        const aiResponse = completion.choices[0].message.content;
        
        // Add AI response to session
        session.messages.push({
            role: 'assistant',
            content: aiResponse,
            timestamp: new Date()
        });

        // Analyze response for additional features
        const subject = classifySubject(userMessage);
        const suggestions = generateSuggestions(subject, userMessage, session.grade);
        const encouragement = generateEncouragement(session);

        return {
            text: aiResponse,
            subject: subject,
            suggestions: suggestions,
            encouragement: encouragement
        };
    } catch (error) {
        console.error('AI API Error:', error);
        
        // Enhanced fallback response
        const fallbackResponse = generateContextualFallback(userMessage, session);
        session.messages.push({
            role: 'assistant',
            content: fallbackResponse,
            timestamp: new Date()
        });

        return {
            text: fallbackResponse,
            subject: classifySubject(userMessage),
            suggestions: generateSuggestions(classifySubject(userMessage), userMessage, session.grade),
            encouragement: generateEncouragement(session)
        };
    }
}

// Enhanced subject classification
function classifySubject(input) {
    const subjects = {
        math: ['math', 'number', 'count', 'add', 'subtract', 'multiply', 'divide', 'calculation', 'algebra', 'geometry', 'fraction', 'decimal', 'percent', 'equation', 'problem'],
        reading: ['read', 'book', 'story', 'word', 'letter', 'spell', 'sentence', 'paragraph', 'chapter', 'author', 'character', 'plot', 'vocabulary'],
        science: ['science', 'animal', 'plant', 'space', 'earth', 'experiment', 'biology', 'chemistry', 'physics', 'nature', 'weather', 'ocean', 'planet'],
        history: ['history', 'past', 'ancient', 'president', 'country', 'war', 'culture', 'civilization', 'timeline', 'historical'],
        art: ['art', 'draw', 'paint', 'create', 'music', 'dance', 'creative', 'design', 'color', 'artist'],
        writing: ['write', 'essay', 'poem', 'story', 'creative writing', 'journal', 'composition', 'grammar'],
        social: ['social', 'community', 'friendship', 'family', 'culture', 'society', 'people', 'relationship']
    };

    const lowerInput = input.toLowerCase();
    for (const [subject, keywords] of Object.entries(subjects)) {
        if (keywords.some(keyword => lowerInput.includes(keyword))) {
            return subject;
        }
    }
    return null;
}

// Generate grade-appropriate suggestions
function generateSuggestions(subject, userMessage, grade) {
    const baseSuggestions = {
        math: [
            'Let\'s try another math problem!',
            'Want to explore math in real life?',
            'How about a fun math game?'
        ],
        reading: [
            'Let\'s read something together!',
            'Want to learn new vocabulary?',
            'How about creating our own story?'
        ],
        science: [
            'Let\'s explore more science!',
            'Want to learn about nature?',
            'How about a cool science fact?'
        ],
        writing: [
            'Let\'s practice writing!',
            'Want to be creative with words?',
            'How about writing a short story?'
        ]
    };

    const generalSuggestions = [
        'What else interests you?',
        'Let\'s try something new!',
        'What would you like to explore?',
        'Ready for another challenge?'
    ];

    return baseSuggestions[subject] || generalSuggestions;
}

// Generate encouragement based on session progress
function generateEncouragement(session) {
    const encouragements = [
        `You're doing great, ${session.studentName}!`,
        `I love how curious you are!`,
        `Keep up the excellent thinking!`,
        `You're such a good learner!`,
        `I'm proud of how hard you're working!`
    ];

    if (session.totalInteractions >= 10) {
        encouragements.push(`Wow! You've been so engaged in our conversation!`);
    }

    return encouragements[Math.floor(Math.random() * encouragements.length)];
}

// Generate contextual fallback responses
function generateContextualFallback(input, session) {
    const fallbacks = [
        `That's really interesting, ${session.studentName}! Can you tell me more about that?`,
        `I love how you think about things! What else comes to mind?`,
        `You're asking such good questions! Let's explore this together!`,
        `That's a great point! What do you think we should consider next?`,
        `I can see you're really thinking hard about this! What connections can you make?`
    ];

    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// Session management endpoints
app.get('/api/session/:sessionId/status', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        active: true,
        duration: Math.floor((Date.now() - session.startTime.getTime()) / 60000),
        interactions: session.totalInteractions,
        topics: Array.from(session.topicsDiscussed)
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date(),
        activeSessions: sessions.size,
        uptime: process.uptime()
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

// Start server
app.listen(PORT, () => {
    console.log(`🎓 Enhanced AI Tutor Backend running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🚀 Ready to help students learn!`);
});

module.exports = app;