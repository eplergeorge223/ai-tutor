const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

// Configuration
const config = {
  PORT: process.env.PORT || 3000,
  SESSION_TTL: 45 * 60 * 1000,
  CLEANUP_INTERVAL: 5 * 60 * 1000,
  GPT_MODEL: 'gpt-4o-mini',
  GPT_TEMPERATURE: 0.7,
  GPT_PRESENCE_PENALTY: 0.1,
  GPT_FREQUENCY_PENALTY: 0.1,
  VALID_GRADES: ['PreK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
  INAPPROPRIATE_TOPICS: {
    sexual: ['breast', 'condom', 'erotic', 'intercourse', 'masturbate', 'naked', 'orgasm', 'penis', 'porn', 'pregnancy', 'sex', 'sexual', 'vagina'],
    violence: ['abuse', 'blood', 'bomb', 'death', 'gun', 'hurt', 'kill', 'knife', 'murder', 'pain', 'suicide', 'violence', 'weapon'],
    profanity: ['ass', 'bastard', 'bitch', 'cock', 'crap', 'damn', 'dick', 'fuck', 'hell', 'piss', 'pussy', 'shit'],
    drugs: ['alcohol', 'beer', 'cigarette', 'cocaine', 'drugs', 'heroin', 'high', 'marijuana', 'smoking', 'weed', 'wine'],
    inappropriate: ['dumb', 'fat', 'hate', 'idiot', 'loser', 'retard', 'stupid', 'ugly']
  }
};

// Initialize app and middleware
const app = express();
app.use(cors());
app.use(express.json({ limit: '4kb' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({
  windowMs: 60_000,
  max: 50,
  message: { error: 'Too many requests, please try again later.' }
}));
app.use(express.static('public'));

// Initialize OpenAI
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ FATAL: Missing OPENAI_API_KEY environment variable');
  process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Session storage
const sessions = new Map();

// Subject classification data
const subjects = {
  math: {
    keywords: ['math', 'number', 'add', 'subtract', 'plus', 'minus', 'multiply', 'divide', 'fraction', 'decimal', 'algebra', 'geometry', 'count'],
    subtopics: {
      counting: ['count', 'number', 'how many'],
      addition: ['add', 'plus'],
      subtraction: ['subtract', 'minus'],
      multiplication: ['multiply', 'times'],
      division: ['divide', 'divided'],
      fractions: ['fraction'],
      algebra: ['algebra', 'equation'],
      geometry: ['geometry', 'shape', 'angle', 'area']
    }
  },
  reading: {
    keywords: ['read', 'reading', 'book', 'story', 'word', 'letter', 'phonics', 'vocabulary'],
    subtopics: {
      phonics: ['phonics', 'sound'],
      vocabulary: ['vocabulary', 'word', 'definition'],
      comprehension: ['comprehension', 'understand', 'main idea'],
      stories: ['story', 'chapter', 'book']
    }
  },
  science: {
    keywords: ['science', 'experiment', 'animal', 'plant', 'space', 'weather', 'nature'],
    subtopics: {
      animals: ['animal', 'mammal', 'bird', 'fish'],
      plants: ['plant', 'tree', 'flower'],
      space: ['space', 'planet', 'star', 'moon'],
      weather: ['weather', 'rain', 'cloud', 'storm']
    }
  }
};

// Utility functions
const generateSessionId = () => Date.now().toString(36) + Math.random().toString(36).substr(2);

function containsInappropriateContent(text) {
  const lowerText = text.toLowerCase();
  for (const [category, words] of Object.entries(config.INAPPROPRIATE_TOPICS)) {
    for (const word of words) {
      if (new RegExp(`\\b${word}\\b`, 'i').test(lowerText)) {
        return { inappropriate: true, category, word };
      }
    }
  }
  return { inappropriate: false };
}

function classifySubject(input) {
  if (!input) return { subject: null, subtopic: null };
  const lowerInput = input.toLowerCase();

  for (const [subject, data] of Object.entries(subjects)) {
    if (data.keywords.some(keyword => new RegExp(`\\b${keyword}\\b`).test(lowerInput))) {
      let bestSub = null, bestLength = 0;
      for (const [subtopic, subwords] of Object.entries(data.subtopics || {})) {
        for (const subword of subwords) {
          if (new RegExp(`\\b${subword}\\b`).test(lowerInput) && subword.length > bestLength) {
            bestSub = subtopic;
            bestLength = subword.length;
          }
        }
      }
      return { subject, subtopic: bestSub };
    }
  }
  return { subject: null, subtopic: null };
}

function getTutorSystemPrompt(grade, studentName, session = null) {
  const responseLength = {
    'PreK': '1 sentence max',
    'K': '1-2 sentences',
    '1': '1-2 sentences',
    '2': '2 sentences',
    '3': '2-3 sentences',
    '4': '2-3 sentences',
    '5': '3 sentences',
    '6': '3-4 sentences',
    '7': '3-4 sentences',
    '8': '3-4 sentences',
    '9': '4-5 sentences',
    '10': '4-5 sentences',
    '11': '4-5 sentences',
    '12': '4-5 sentences'
  };

  const paceInstruction = session?.conversationPatterns?.preferredPace === 'fast' 
    ? `${studentName} responds quickly - keep answers brief and direct.`
    : `Give ${studentName} time to process.`;

  const basePrompt = `You are an AI Tutor for ${studentName} (Grade ${grade}). 
CORE RULES:
- Teach students to THINK, not memorize
- Use ${responseLength[grade] || '2-3 sentences'}
- ${paceInstruction}
- Be encouraging and patient
- If wrong answer, gently correct and explain why
- Redirect inappropriate topics: "Let's explore something educational instead!"
- Use age-appropriate language
- Celebrate effort and progress

EXAMPLES:
- Math: "Let's count 5 plus 5 on your fingers. What do you get?"
- Reading: "Sound out c-a-t. What word is that?"
- Science: "What happens to ice in the sun?"`;

  if (['PreK', 'K', '1', '2'].includes(grade)) {
    return basePrompt + `\n\nFor reading activities, respond in JSON format:
{"message": "Can you read this word?", "READING_WORD": "cat"}`;
  }

  return basePrompt;
}

function createSession(sessionId, studentName, grade, subjects) {
  return {
    id: sessionId,
    studentName: studentName || 'Student',
    grade: grade || 'K',
    subjects: subjects || [],
    startTime: new Date(),
    lastActivity: Date.now(),
    messages: [{ 
      role: 'system', 
      content: getTutorSystemPrompt(grade, studentName), 
      timestamp: new Date() 
    }],
    totalWarnings: 0,
    topicsDiscussed: new Set(),
    topicBreakdown: {},
    conversationContext: [],
    conversationPatterns: {
      preferredPace: 'normal',
      interruptionCount: 0,
      lastResponseTime: Date.now()
    }
  };
}

function getMaxTokensForGrade(grade) {
  const gradeLevel = parseInt(grade) || 0;
  if (gradeLevel <= 2) return 50;
  if (gradeLevel <= 5) return 75;
  if (gradeLevel <= 8) return 100;
  return 125;
}

function generateRedirectResponse(category, session) {
  const redirects = {
    sexual: `That's not something we talk about in learning time, ${session.studentName}! What subject interests you?`,
    violence: `I help with positive learning, ${session.studentName}! What would you like to learn?`,
    profanity: `Let's use kind words, ${session.studentName}. What topic interests you?`,
    drugs: `That's not appropriate for learning time! What educational topic interests you?`,
    inappropriate: `Let's focus on learning amazing things, ${session.studentName}! What topic would you like to explore?`
  };
  return redirects[category] || redirects.inappropriate;
}

function generateDynamicSuggestions(session) {
  const recent = session.conversationContext.slice(-3);
  const lastUser = recent.filter(c => c.role === 'user').pop();
  
  if (!lastUser) return getGeneralSuggestions(session.grade);
  
  const suggestions = [];
  const topic = lastUser.topic;
  
  if (topic === 'math') {
    suggestions.push("Want to try another math problem?", "Let's explore more numbers!", "How about counting practice?");
  } else if (topic === 'reading') {
    suggestions.push("Can you read another word?", "Let's try a different story!", "What about new vocabulary?");
  } else if (topic === 'science') {
    suggestions.push("Want to learn about animals?", "Let's explore nature!", "How about an experiment?");
  } else {
    suggestions.push("Tell me more about that!", "What else interests you?", "Let's explore further!");
  }
  
  return suggestions.slice(0, 3);
}

function getGeneralSuggestions(grade) {
  const gradeLevel = parseInt(grade) || 0;
  if (gradeLevel <= 2) return ['Let\'s count!', 'Want to learn colors?', 'How about animals?'];
  if (gradeLevel <= 5) return ['Let\'s explore science!', 'Want to practice math?', 'How about reading?'];
  return ['Let\'s dive into a subject!', 'Want to solve problems?', 'How about learning something new?'];
}

function generateEncouragement(session) {
  const encouragements = [
    `You're doing great, ${session.studentName}!`,
    `I love how curious you are!`,
    `Keep up the excellent thinking!`,
    `You're such a good learner!`,
    `Your questions show you're really thinking!`
  ];
  return encouragements[Math.floor(Math.random() * encouragements.length)];
}

function generateWelcomeMessage(studentName, grade) {
  const messages = {
    'PreK': `Hi ${studentName}! Let's learn together!`,
    'K': `Hello ${studentName}! What sounds fun today?`,
    '1': `Hi ${studentName}! Ready to learn cool things?`,
    '2': `Hey ${studentName}! What should we explore?`,
    '3': `Hi ${studentName}! What are you curious about?`,
    '4': `Hello ${studentName}! What interests you today?`,
    '5': `Hi ${studentName}! What would you like to learn?`,
    '6': `Hey ${studentName}! What's on your mind?`,
    '7': `Hi ${studentName}! What interests you?`,
    '8': `Hello ${studentName}! What should we discover?`,
    '9': `Hi ${studentName}! What can I help with?`,
    '10': `Hey ${studentName}! What's your focus today?`,
    '11': `Hello ${studentName}! What topic interests you?`,
    '12': `Hi ${studentName}! What can we explore today?`
  };
  return messages[grade] || messages['K'];
}

async function generateAIResponse(sessionId, userMessage) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  session.messages.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date()
  });

  // Keep conversation manageable
  if (session.messages.length > 6) {
    session.messages = session.messages.slice(-6);
  }

  // Track conversation patterns
  const timeSinceLastResponse = Date.now() - session.conversationPatterns.lastResponseTime;
  if (timeSinceLastResponse < 5000) {
    session.conversationPatterns.interruptionCount++;
    session.conversationPatterns.preferredPace = 'fast';
  }
  session.conversationPatterns.lastResponseTime = Date.now();

  const systemPrompt = getTutorSystemPrompt(session.grade, session.studentName, session);
  const conversationHistory = session.messages.filter(m => m.role !== 'system').slice(-4);
  
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(msg => ({ role: msg.role, content: msg.content }))
  ];

  try {
    let maxTokens = getMaxTokensForGrade(session.grade);
    if (userMessage.toLowerCase().includes('story')) {
      maxTokens = Math.min(maxTokens * 2, 300);
    }

    const completion = await openai.chat.completions.create({
      model: config.GPT_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: config.GPT_TEMPERATURE,
      presence_penalty: config.GPT_PRESENCE_PENALTY,
      frequency_penalty: config.GPT_FREQUENCY_PENALTY,
      stop: ["\n\n", "Additionally,", "Furthermore,", "Moreover,"]
    });

    const aiText = completion.choices[0].message.content.trim();
    
    session.messages.push({
      role: 'assistant',
      content: aiText,
      timestamp: new Date()
    });

    return {
      text: aiText,
      subject: classifySubject(userMessage),
      encouragement: generateEncouragement(session)
    };

  } catch (error) {
    console.error(`❌ AI API Error for session ${sessionId.slice(-6)}:`, error.message);
    const fallback = `That's interesting, ${session.studentName}! Tell me more!`;
    
    session.messages.push({
      role: 'assistant',
      content: fallback,
      timestamp: new Date()
    });

    return {
      text: fallback,
      subject: classifySubject(userMessage),
      encouragement: generateEncouragement(session)
    };
  }
}

// Cleanup expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.lastActivity > config.SESSION_TTL) {
      console.log(`🧹 Cleaning up expired session ${id.slice(-6)}`);
      sessions.delete(id);
    }
  }
}, config.CLEANUP_INTERVAL);

// API Routes
app.post('/api/session/start', async (req, res) => {
  try {
    const sessionId = generateSessionId();
    const { studentName, grade, subjects } = req.body;

    if (typeof studentName !== 'string' || typeof grade !== 'string') {
      return res.status(400).json({ error: 'Invalid session parameters.' });
    }

    const validatedGrade = config.VALID_GRADES.includes(grade) ? grade : 'K';
    const validatedName = studentName?.trim() || 'Student';

    const session = createSession(sessionId, validatedName, validatedGrade, subjects);
    sessions.set(sessionId, session);

    console.log(`🚀 Session started: ${sessionId.slice(-6)}, Student: ${validatedName}, Grade: ${validatedGrade}`);

    res.json({
      sessionId,
      welcomeMessage: generateWelcomeMessage(validatedName, validatedGrade),
      status: 'success',
      sessionInfo: {
        studentName: validatedName,
        grade: validatedGrade,
        startTime: session.startTime
      }
    });
  } catch (error) {
    console.error('❌ Error starting session:', error.message);
    res.status(500).json({ error: 'Failed to start session. Please try again.' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({ error: 'Invalid or expired session.' });
    }

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    const session = sessions.get(sessionId);
    session.lastActivity = Date.now();

    const cleanedMessage = message.trim();
    
    // Handle thinking pauses
    if (cleanedMessage.length < 3 || /^(um+|uh+|er+|hmm+)$/i.test(cleanedMessage)) {
      return res.json({
        response: `I'm listening, ${session.studentName}! Take your time.`,
        subject: null,
        suggestions: ["Go ahead!", "I'm here!", "What were you thinking?"],
        encouragement: "Take your time!",
        status: 'listening'
      });
    }

    // Content filtering
    const contentCheck = containsInappropriateContent(message);
    if (contentCheck.inappropriate) {
      session.totalWarnings = (session.totalWarnings || 0) + 1;
      const redirectResponse = generateRedirectResponse(contentCheck.category, session);
      
      console.warn(`🚨 Inappropriate content: ${sessionId.slice(-6)}: "${contentCheck.word}"`);
      
      return res.json({
        response: redirectResponse,
        subject: null,
        suggestions: getGeneralSuggestions(session.grade),
        encouragement: generateEncouragement(session),
        status: 'redirected'
      });
    }

    const response = await generateAIResponse(sessionId, cleanedMessage);

    // Track conversation context
    const subjectInfo = classifySubject(message);
    session.conversationContext.push({
      role: 'user',
      message: message,
      topic: subjectInfo.subject,
      timestamp: Date.now()
    });

    session.conversationContext.push({
      role: 'assistant',
      message: response.text,
      topic: subjectInfo.subject,
      timestamp: Date.now()
    });

    if (session.conversationContext.length > 10) {
      session.conversationContext = session.conversationContext.slice(-10);
    }

    // Update topic tracking
    if (subjectInfo.subject) {
      session.topicsDiscussed.add(subjectInfo.subject);
      if (!session.topicBreakdown[subjectInfo.subject]) {
        session.topicBreakdown[subjectInfo.subject] = {};
      }
      if (subjectInfo.subtopic) {
        session.topicBreakdown[subjectInfo.subject][subjectInfo.subtopic] = 
          (session.topicBreakdown[subjectInfo.subject][subjectInfo.subtopic] || 0) + 1;
      }
    }

    // Handle reading word display for early grades
    let messageText = response.text;
    let readingWord = null;
    
    try {
      const maybeJson = JSON.parse(messageText);
      if (maybeJson?.READING_WORD) {
        messageText = maybeJson.message;
        readingWord = maybeJson.READING_WORD;
      }
    } catch (e) {
      // Not JSON, continue normally
    }

    res.json({
      response: messageText,
      readingWord,
      subject: response.subject,
      suggestions: generateDynamicSuggestions(session),
      encouragement: response.encouragement,
      status: 'success',
      sessionStats: {
        totalWarnings: session.totalWarnings || 0,
        topicsDiscussed: Array.from(session.topicsDiscussed)
      }
    });

  } catch (error) {
    console.error(`❌ Chat error: ${req.body.sessionId?.slice(-6) || 'N/A'}:`, error.message);
    res.status(500).json({
      error: 'Failed to process message. Please try again.',
      fallback: 'I\'m having trouble right now, but I\'m here to help you learn!'
    });
  }
});

app.get('/api/session/:sessionId/summary', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    const duration = Math.floor((Date.now() - session.startTime.getTime()) / 60000);
    const topics = Array.from(session.topicsDiscussed);

    res.json({
      duration: duration > 0 ? `${duration} minutes` : 'Less than a minute',
      totalWarnings: session.totalWarnings || 0,
      topicsExplored: topics.length > 0 ? topics.join(', ') : 'General conversation',
      studentName: session.studentName,
      grade: session.grade,
      highlights: [`${session.studentName} showed curiosity and engagement in learning`],
      suggestions: [`Continue exploring topics that interest you, ${session.studentName}!`],
      nextSteps: ['Keep practicing and asking great questions!']
    });
  } catch (error) {
    console.error(`❌ Summary error: ${req.params.sessionId?.slice(-6) || 'N/A'}:`, error.message);
    res.status(500).json({ error: 'Failed to get session summary.' });
  }
});

app.post('/api/session/:sessionId/end', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    sessions.delete(sessionId);
    console.log(`🛑 Session ${sessionId.slice(-6)} ended`);

    res.json({ status: 'ended', message: 'Session successfully closed.' });
  } catch (error) {
    console.error('❌ Error ending session:', error.message);
    res.status(500).json({ error: 'Internal error ending session.' });
  }
});

app.get('/api/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

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
  console.log(`📊 Health check: http://localhost:${config.PORT}/api/health`);
  console.log(`🚀 Ready to help students learn safely!`);
});

// Graceful shutdown
['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });
});

module.exports = app;