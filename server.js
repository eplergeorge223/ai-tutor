const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

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
app.use(express.static('public'));

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

// Routes
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
    } catch (e) {}
    
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
      encouragement: generateResponse('encourage', session.studentName),
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

// Start server
const server = app.listen(config.PORT, () => {
  console.log(`🎓 AI Tutor Backend running on port ${config.PORT}`);
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