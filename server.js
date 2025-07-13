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
    math: ['math', 'number', 'add', 'subtract', 'multiply', 'divide', 'count', 'fraction', 'algebra', 'geometry', 'calculate', 'solve', 'plus', 'minus', 'times', 'equation'],
    reading: ['read', 'book', 'story', 'word', 'phonics', 'vocabulary', 'comprehension', 'write', 'spell', 'letter', 'sound'],
    science: ['science', 'animal', 'plant', 'space', 'weather', 'experiment', 'nature', 'biology', 'physics', 'chemistry'],
    socialStudies: ['history', 'government', 'geography', 'culture', 'map', 'president', 'country', 'capital'],
    art: ['art', 'draw', 'paint', 'color', 'creative', 'design'],
    music: ['music', 'song', 'sing', 'instrument', 'rhythm', 'melody']
  }
};

// Build vocabulary from subjects
const VOCABULARY = [
  ...Object.values(config.SUBJECTS).flat(),
  'painting', 'reading', 'algebra', 'geometry', 'fraction',
  'biology', 'physics', 'history', 'government', 'capital',
  'what', 'how', 'when', 'where', 'why', 'who', 'tell', 'explain', 'teach', 'learn'
];

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
  return level <= 2 ? 40
       : level <= 5 ? 60
       : level <= 8 ? 80
       : 100;
};

/**
 * Simple Levenshtein distance implementation
 */
function levenshteinDistance(a, b) {
  const matrix = [];
  
  // Create matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  // Fill matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

/**
 * Fuzzy correction using Levenshtein distance
 */
function fuzzyCorrect(text) {
  return text
    .split(/\s+/)
    .map(word => {
      // Skip very short words or words that are already in vocabulary
      if (word.length <= 2) return word;
      
      const lowerWord = word.toLowerCase();
      
      // Check if word is already correct
      if (VOCABULARY.some(v => v.toLowerCase() === lowerWord)) {
        return word;
      }
      
      let bestMatch = { word: word, distance: Infinity };
      
      // Find the best match in vocabulary
      for (const candidate of VOCABULARY) {
        const distance = levenshteinDistance(lowerWord, candidate.toLowerCase());
        if (distance < bestMatch.distance) {
          bestMatch = { word: candidate, distance: distance };
        }
      }
      
      // Only correct if the distance is reasonable (1-2 characters different)
      // and the word lengths are similar
      if (bestMatch.distance <= 2 && 
          Math.abs(word.length - bestMatch.word.length) <= 2) {
        return bestMatch.word;
      }
      
      return word;
    })
    .join(' ');
}

/**
 * Detect if response should generate a flashcard
 */
function shouldCreateFlashcard(response, grade) {
  const mathPatterns = [
    /what\s+is\s+(\d+\s*[\+\-\*\/]\s*\d+)/i,
    /calculate\s+(\d+\s*[\+\-\*\/]\s*\d+)/i,
    /solve\s+(\d+\s*[\+\-\*\/]\s*\d+)/i
  ];
  
  const spellingPatterns = [
    /spell\s+.*["""]?(\w+)["""]?/i,
    /how\s+do\s+you\s+spell\s+(\w+)/i
  ];
  
  const letterPatterns = [
    /what\s+letter\s+comes\s+after\s+(\w)/i,
    /what\s+comes\s+next\s+after\s+(\w)/i
  ];
  
  const capitalPatterns = [
    /what\s+is\s+the\s+capital\s+of\s+(\w+)/i,
    /capital\s+of\s+(\w+)/i
  ];
  
  return mathPatterns.some(p => p.test(response)) ||
         spellingPatterns.some(p => p.test(response)) ||
         letterPatterns.some(p => p.test(response)) ||
         capitalPatterns.some(p => p.test(response));
}

/**
 * Extract flashcard data from AI response
 */
function extractFlashcardData(response) {
  // Math problems
  const mathMatch = response.match(/what\s+is\s+(\d+\s*[\+\-\*\/]\s*\d+(?:\s*[\+\-\*\/]\s*\d+)*)/i);
  if (mathMatch) {
    const problem = mathMatch[1];
    try {
      const answer = eval(problem.replace(/\s/g, ''));
      return {
        prompt: "What is...",
        front: problem,
        back: answer.toString()
      };
    } catch (e) {
      return null;
    }
  }
  
  // Spelling
  const spellMatch = response.match(/(?:spell|how\s+do\s+you\s+spell)\s+.*["""]?(\w+)["""]?/i);
  if (spellMatch) {
    const word = spellMatch[1].toLowerCase();
    const spelled = word.split('').join('-');
    return {
      prompt: "Spell the word:",
      front: word,
      back: spelled.toUpperCase()
    };
  }
  
  // Letter sequence
  const letterMatch = response.match(/what\s+letter\s+comes\s+after\s+(\w)/i);
  if (letterMatch) {
    const letter = letterMatch[1].toUpperCase();
    const nextLetter = String.fromCharCode(letter.charCodeAt(0) + 1);
    return {
      prompt: "What letter comes after:",
      front: letter,
      back: nextLetter
    };
  }
  
  // Capital cities
  const capitalMatch = response.match(/what\s+is\s+the\s+capital\s+of\s+(\w+)/i);
  if (capitalMatch) {
    const state = capitalMatch[1];
    const capitals = {
      'california': 'Sacramento',
      'texas': 'Austin',
      'florida': 'Tallahassee',
      'newyork': 'Albany',
      'illinois': 'Springfield'
    };
    const capital = capitals[state.toLowerCase()];
    if (capital) {
      return {
        prompt: "What is the capital of:",
        front: state,
        back: capital
      };
    }
  }
  
  return null;
}

/**
 * Check if we should show a reading word (for early grades)
 */
function extractReadingWord(response, grade) {
  if (!['PreK', 'K', '1', '2'].includes(grade)) return null;
  
  const readingPatterns = [
    /can\s+you\s+read\s+.*word\s+["""]?(\w+)["""]?/i,
    /sound\s+out\s+.*word\s+["""]?(\w+)["""]?/i,
    /try\s+reading\s+["""]?(\w+)["""]?/i
  ];
  
  for (const pattern of readingPatterns) {
    const match = response.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  
  return null;
}

const getTutorPrompt = (grade, name) => {
  const responseLength = {
    'PreK': '1 sentence max',
    'K':   '1 sentence max',
    '1':   '1 sentence max',
    '2':   '1 sentence max',
    '3':   '1-2 sentences',
    '4':   '1-2 sentences',
    '5':   '2 sentences max',
    '6':   '2 sentences max',
    '7':   '2 sentences max',
    '8':   '2 sentences max',
    '9':   '2-3 sentences',
    '10':  '2-3 sentences',
    '11':  '2-3 sentences',
    '12':  '2-3 sentences'
  };

  const mathInstruction = `For math problems, phrase as questions like "What is 5 + 3?" or "Can you solve 12 ÷ 4?"`;
  const spellingInstruction = `For spelling, ask "How do you spell 'cat'?" or "Can you spell 'dog'?"`;
  const readingInstruction = ['PreK', 'K', '1', '2'].includes(grade) ? 
    `For reading, ask "Can you read this word: 'sun'?" or "Try reading 'cat'"` : '';

  return `You are an AI Tutor for ${name} (Grade ${grade}). Teach students to THINK, not memorize!
- Keep responses ${responseLength[grade] || '2-3 sentences'}
- Use age-appropriate language for grade ${grade}
- Be encouraging and patient
- If wrong answer, gently correct and explain why
- Avoid inappropriate topics - redirect to learning
- Show step-by-step thinking
- ${mathInstruction}
- ${spellingInstruction}
- ${readingInstruction}
- Ask engaging questions to keep them learning`;
};

const generateResponse = (type, name, grade) => {
  const responses = {
    welcome: {
      'PreK': `Hi ${name}! Let's learn and play!`, 
      'K': `Hello ${name}! What's fun to learn today?`,
      '1': `Hi ${name}! Ready to explore?`, 
      '2': `Hey ${name}! What should we discover?`,
      '3': `Hi ${name}! What interests you today?`, 
      '4': `Hello ${name}! What's on your curious mind?`,
      '5': `Hi ${name}! What would you like to learn about?`, 
      '6': `Hey ${name}! What topic interests you?`,
      '7': `Hi ${name}! What can we explore together?`, 
      '8': `Hello ${name}! What should we discover?`,
      '9': `Hi ${name}! What can I help you learn?`, 
      '10': `Hey ${name}! What's your focus today?`,
      '11': `Hello ${name}! What topic would you like to explore?`, 
      '12': `Hi ${name}! What can we dive into today?`
    },
    redirect: `I'm here to help you learn amazing things, ${name}! What would you like to explore today?`,
    encourage: [`Great job, ${name}!`, `You're doing amazing!`, `Keep thinking!`, `I love your curiosity!`, `Excellent work!`, `You're so smart!`],
    suggestions: {
      early: ['Let\'s count to 10!', 'What about animal sounds?', 'Can you name colors?', 'Let\'s read simple words!'],
      middle: ['Try some math problems!', 'Let\'s read a story!', 'Explore cool science!', 'Learn about animals!'],
      high: ['Solve challenging problems!', 'Discover something new!', 'Dive deeper into topics!', 'Practice advanced skills!']
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
  id, 
  studentName: name || 'Student', 
  grade: grade || 'K', 
  subjects: subjects || [],
  startTime: new Date(), 
  lastActivity: Date.now(), 
  totalWarnings: 0,
  messages: [{ role: 'system', content: getTutorPrompt(grade, name), timestamp: new Date() }],
  topicsDiscussed: new Set(), 
  conversationContext: []
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
      sessionInfo: { 
        studentName: validatedName, 
        grade: validatedGrade, 
        startTime: session.startTime 
      }
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
    
    let cleanedMessage = message.trim();
    
    // Apply fuzzy correction only if needed
    try {
      cleanedMessage = fuzzyCorrect(cleanedMessage);
    } catch (error) {
      console.warn('⚠️ Fuzzy correction failed, using original message:', error.message);
      cleanedMessage = message.trim();
    }

    // Special case "can you hear me"
    if (/^can you hear me\??$/i.test(cleanedMessage)) {
      return res.json({
        response: 'Yes! I can hear you loud and clear. What would you like to learn about?',
        suggestions: generateResponse('suggestions', null, session.grade),
        status: 'success'
      });
    }
    
    // Handle thinking pauses
    if (cleanedMessage.length < 3 || /^(um+|uh+|er+|hmm+)$/i.test(cleanedMessage)) {
      return res.json({
        response: `Take your time, ${session.studentName}! I'm here when you're ready.`,
        suggestions: ["What's on your mind?", "Ask me anything!", "I'm listening!"],
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
    
    // Check for flashcard opportunity
    const flashcardData = extractFlashcardData(aiResponse);
    
    // Check for reading word (early grades only)
    const readingWord = extractReadingWord(aiResponse, session.grade);
    
    const responseData = {
      response: aiResponse,
      subject,
      suggestions: generateResponse('suggestions', null, session.grade),
      encouragement: generateResponse('encourage', session.studentName),
      status: 'success',
      sessionStats: {
        totalWarnings: session.totalWarnings,
        topicsDiscussed: Array.from(session.topicsDiscussed)
      }
    };
    
    // Add flashcard data if available
    if (flashcardData) {
      responseData.flashcard = flashcardData;
    }
    
    // Add reading word if available
    if (readingWord) {
      responseData.readingWord = readingWord;
    }
    
    res.json(responseData);
    
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
      highlights: [
        `${session.studentName} engaged wonderfully in learning!`,
        `Great curiosity and participation shown`,
        `Excellent questions asked during the session`
      ],
      suggestions: [
        `Keep practicing ${topics[0] || 'various topics'}!`,
        `Try exploring new areas of interest`,
        `Continue asking great questions`
      ],
      nextSteps: [
        'Continue exploring topics that interest you!',
        'Practice what you learned today',
        'Come back anytime to learn more!'
      ]
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
    
    res.json({ 
      status: 'ended', 
      message: 'Session closed successfully',
      finalMessage: `Great job learning today, ${session.studentName}!`
    });
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
    topics: Array.from(session.topicsDiscussed),
    studentName: session.studentName,
    grade: session.grade
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