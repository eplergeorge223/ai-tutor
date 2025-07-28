const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// --- Configuration ---
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
    sexual: ['sex', 'sexual', 'porn', 'vagina', 'penis', 'breasts', 'naked', 'intercourse', 'masturbate', 'orgasm', 'condom', 'pregnancy'],
    violence: ['kill', 'murder', 'bomb', 'gun', 'knife', 'suicide', 'violence', 'abuse', 'hurt', 'pain', 'blood', 'weapon'],
    profanity: ['fuck', 'shit', 'asshole', 'bitch', 'cunt', 'damn', 'hell', 'crap', 'piss', 'dick', 'cock'],
    drugs: ['drugs', 'drug', 'marijuana', 'weed', 'cocaine', 'heroin', 'alcohol', 'beer', 'wine', 'smoking', 'high', 'drunk'],
    hateSpeech: ['racist', 'n-word', 'faggot', 'retard', 'idiot', 'stupid', 'loser', 'ugly', 'fat', 'dumb', 'hate'],
    inappropriateGeneral: ['gang', 'crime', 'cult', 'gossip', 'rumor', 'cheating', 'fraud']
  }
};

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ FATAL: Missing OPENAI_API_KEY environment variable');
  process.exit(1);
}

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sessions = new Map();

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '4kb' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({
  windowMs: 60_000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
}));
app.use(express.static('public'));

// --- Session Cleanup ---
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.lastActivity > config.SESSION_TTL) {
      console.log(`🧹 Cleaning expired session ${id.slice(-6)}`);
      sessions.delete(id);
    }
  }
}, config.CLEANUP_INTERVAL);

// --- Helper Functions ---
const capitalize = str => str.charAt(0).toUpperCase() + str.slice(1);
const generateSessionId = () => Date.now().toString(36) + Math.random().toString(36).substr(2);

const gradeGuidelines = {
  PreK: 'Use very simple words. 1–2 sentences max. Focus on colors, shapes, and sounds.',
  K: 'Simple words, 2-3 sentences. Basic counting and letters.',
  '1': '2-3 sentences. Simple reading and basic math.',
  '2': '3 sentences. Building vocabulary and math skills.',
  '3': '3-4 sentences. More complex problems and reading.',
  '4': '4 sentences. Multi-step problems and comprehension.',
  '5': '4 sentences. Advanced concepts and critical thinking.',
  '6': '4-5 sentences. Abstract thinking and analysis.',
  '7': '4-5 sentences. Complex reasoning and connections.',
  '8': '4-5 sentences. Advanced problem-solving.',
  '9': '4-5 sentences. Higher-order thinking skills.',
  '10': '4-5 sentences. College-prep level thinking.',
  '11': '4-5 sentences. Advanced analysis and synthesis.',
  '12': '4-5 sentences. Prepare for higher-level thinking.'
};

const getMaxTokensForGrade = grade => {
  if (['PreK', 'K', '1', '2'].includes(grade)) return 80;
  if (['3', '4', '5'].includes(grade)) return 100;
  if (['6', '7', '8'].includes(grade)) return 120;
  return 150;
};

const getTutorSystemPrompt = (grade, studentName, difficultyLevel = 0.5, needsFoundationalReview = null, readingTask = false) => {
  const guideline = gradeGuidelines[grade] || gradeGuidelines.K;
  
  let difficultyAdjustment = 'Maintain a steady, encouraging pace with balanced support and challenge.';
  if (difficultyLevel < 0.3) {
    difficultyAdjustment = 'Student struggling—give extra clear, simple steps and encouraging hints.';
  } else if (difficultyLevel > 0.7) {
    difficultyAdjustment = 'Student grasping quickly—offer more complex challenges and deeper inquiry.';
  }

  let foundationalReview = '';
  if (needsFoundationalReview?.skill === 'counting') {
    foundationalReview = `CRITICAL: Student needs counting review. Guide counting 1-10 before returning to: "${needsFoundationalReview.originalProblem}"`;
  }

  const isEarlyGrade = ['PreK', 'K', '1', '2'].includes(grade);
  const readingInstruction = isEarlyGrade && readingTask ? 
    'For reading: reply in JSON {"message":"...","READING_WORD":"word"} (do NOT spell word in message)' : '';

  return `You are an AI Tutor guiding ${studentName} to THINK, not memorize.
• ${guideline}
• Celebrate effort and curiosity—every attempt is progress.
• Ask guiding questions; break problems into small steps.
• Never give answers outright—prompt discovery with hints.
• When topics requested, suggest 2–3 grade-appropriate options.
${foundationalReview}
${difficultyAdjustment}
${readingInstruction}`.trim();
};

const createSessionObject = (sessionId, studentName, grade) => ({
  id: sessionId,
  studentName: studentName || 'Student',
  grade: grade || 'K',
  startTime: Date.now(),
  lastActivity: Date.now(),
  messages: [{
    role: 'system',
    content: getTutorSystemPrompt(grade, studentName),
    timestamp: Date.now()
  }],
  totalWarnings: 0,
  topicsDiscussed: new Set(),
  currentTopic: null,
  currentSubtopic: null,
  topicBreakdown: {},
  achievements: [],
  strugglingAreas: [],
  difficultyLevel: 0.5,
  needsFoundationalReview: null,
  currentProblem: null
});

const containsInappropriateContent = text => {
  const lowerText = text.toLowerCase();
  for (const [category, words] of Object.entries(config.INAPPROPRIATE_TOPICS)) {
    for (const word of words) {
      if (new RegExp(`\\b${word}\\b`, 'i').test(lowerText)) {
        return { inappropriate: true, category, word };
      }
    }
  }
  return { inappropriate: false };
};

const getInappropriateResponse = (category, session) => {
  const responses = {
    sexual: `That's not something we talk about in our learning time, ${session.studentName}! Let's explore something educational instead.`,
    violence: `I'm here to help you learn positive things, ${session.studentName}! What would you like to learn about?`,
    profanity: `Let's use kind words in our learning space, ${session.studentName}. What would you like to learn today?`,
    drugs: `That's not appropriate for our learning time, ${session.studentName}! Let's focus on something educational.`,
    hateSpeech: `Let's keep our learning space respectful and kind, ${session.studentName}. What topic interests you?`,
    inappropriateGeneral: `I'm here to help you learn amazing things, ${session.studentName}! What educational topic would you like to explore?`
  };

  return {
    response: responses[category] || 'Let\'s find something fun to learn instead!',
    subject: null,
    suggestions: generateSafeSuggestions(session.grade, true),
    encouragement: `Let's get back to learning, ${session.studentName}!`,
    status: 'redirected'
  };
};

const generateWelcomeMessage = (studentName, grade) => {
  const messages = {
    PreK: `Hi ${studentName}! I'm your AI tutor! Let's learn through play—colors, shapes, or animal sounds?`,
    K: `Hello ${studentName}! I'm your AI tutor. We could count, learn letters, or talk about animals—what sounds fun?`,
    '1': `Hey ${studentName}! I'm your AI tutor. Want to practice reading, try a math puzzle, or discover science?`,
    '2': `Hi ${studentName}! I'm your AI tutor. What should we explore—math puzzles, stories, or cool science?`,
    '3': `Hello ${studentName}! I'm your AI tutor. What are you curious about—math, reading, science, or history?`
  };
  return messages[grade] || `Hi ${studentName}! I'm your AI tutor for today. What would you like to explore?`;
};

const generateSafeSuggestions = (grade, forceGeneral = false) => {
  const general = [
    'Let\'s explore the wonders of science!',
    'Want to learn about fascinating animals?',
    'How about some fun math puzzles?',
    'Let\'s read an exciting story together!',
    'What about discovering new music rhythms?',
    'Curious about how technology works?',
    'How about a peek into history?'
  ].sort(() => 0.5 - Math.random());

  if (forceGeneral) return general.slice(0, 3);

  const gradeSpecific = {
    PreK: ['Let\'s learn colors!', 'What about shapes?', 'Let\'s sing a song!'],
    K: ['Let\'s count!', 'What about letters?', 'Let\'s learn animal sounds!'],
    '1': ['Let\'s practice ABCs!', 'How about counting to 100?', 'Tell me about your favorite animal!']
  };

  const suggestions = gradeSpecific[grade] || general;
  return Array.from(new Set([
    ...suggestions.slice(0, 2),
    'Want to pick a new topic?',
    'What else are you curious about?'
  ])).slice(0, 3);
};

const classifySubject = text => {
  const lower = text.toLowerCase();
  const subjects = {
    math: { keywords: ['math', 'add', 'subtract', 'number', 'count'], subtopics: { add: 'addition', subtract: 'subtraction', multiply: 'multiplication', divide: 'division', count: 'counting' }},
    reading: { keywords: ['read', 'story', 'book', 'word', 'letter'], subtopics: { word: 'vocabulary', story: 'comprehension' }},
    science: { keywords: ['science', 'animal', 'space', 'experiment'], subtopics: { animal: 'animals', space: 'space', planet: 'space', star: 'space' }},
    music: { keywords: ['music', 'song', 'instrument'], subtopics: { instrument: 'instruments', rhythm: 'rhythm', beat: 'rhythm' }},
    socialStudies: { keywords: ['history', 'social studies', 'country'], subtopics: { history: 'history', geography: 'geography', map: 'geography', country: 'geography' }},
    pe: { keywords: ['sport', 'exercise', 'fitness'], subtopics: { sport: 'sports', exercise: 'fitness', fitness: 'fitness' }},
    technology: { keywords: ['code', 'computer', 'robot'], subtopics: { code: 'coding', program: 'coding', robot: 'robotics' }},
    language: { keywords: ['language', 'speak', 'spanish', 'french'], subtopics: { vocabulary: 'vocabulary', word: 'vocabulary', grammar: 'grammar', sentence: 'grammar' }}
  };

  for (const [subject, {keywords, subtopics}] of Object.entries(subjects)) {
    if (keywords.some(k => lower.includes(k))) {
      const subtopic = Object.keys(subtopics).find(k => lower.includes(k));
      return { subject, subtopic: subtopics[subtopic] || 'general' };
    }
  }
  return { subject: null, subtopic: null };
};

const generateDynamicSuggestions = session => {
  const suggestions = {
    math: ["Want a math puzzle?", "Switch to a different math topic?", "Try a quick math quiz?"],
    reading: ["Want to read together?", "Need help with tricky words?", "Switch to a fun story?"],
    science: ["Try a science experiment at home?", "Explore another science topic?", "Ask a big science question!"],
    music: ["Want to learn about different instruments?", "How about music from around the world?", "What about composing a simple song?"],
    socialStudies: ["Want to learn about world cultures?", "How about famous leaders?", "What about different forms of government?"],
    pe: ["Want to learn about staying active?", "How about healthy habits?", "What about different ways to play and move?"],
    technology: ["Want to learn about how technology helps us?", "How about exploring the internet?", "What about designing a new app idea?"],
    language: ["Want to learn about a new language?", "How about exploring common phrases?", "What about understanding different alphabets?"]
  };

  const topic = session.currentTopic;
  const topicSuggestions = suggestions[topic] || generateSafeSuggestions(session.grade, true);
  
  return Array.from(new Set([
    ...topicSuggestions.slice(0, 2),
    "Want to pick a new topic?",
    "What else are you curious about?"
  ])).slice(0, 3);
};

const generateEncouragement = () => {
  const encouragements = [
    "Keep up the great work!",
    "You're doing wonderfully!",
    "That's fantastic thinking!",
    "Awesome effort!",
    "You're making great progress!"
  ];
  return encouragements[Math.floor(Math.random() * encouragements.length)];
};

const checkFoundationalSkills = (userMessage, session) => {
  const lower = userMessage.toLowerCase();
  
  if (session.currentTopic === 'math') {
    const countingErrors = [
      'one two three four five seven eight fifteen',
      'one three five',
      'two four six',
      'nine five one'
    ];
    
    if (countingErrors.some(error => lower.includes(error))) {
      session.currentProblem = session.messages.slice(-2, -1)[0]?.content;
      return { skill: 'counting', originalProblem: session.currentProblem };
    }
  }
  return null;
};

const buildPersonalizedSummary = session => {
  const lines = [];
  for (const [subject, breakdown] of Object.entries(session.topicBreakdown)) {
    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const [topSub, topCount] = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0] || [];
    if (topSub) {
      lines.push(`${session.studentName} focused mostly on **${capitalize(topSub)}** in **${capitalize(subject)}** (${Math.round((topCount / total) * 100)}% of questions).`);
    }
  }
  return lines.length ? lines.join(' ') : 'Showed curiosity and asked thoughtful questions throughout the session.';
};

const generateRecommendations = session => {
  const recs = [];
  if (session.strugglingAreas?.length > 0) {
    recs.push(`Consider more time on: **${session.strugglingAreas.join(', ')}** to build stronger understanding.`);
  }
  if (session.achievements?.length > 0) {
    recs.push(`Great job mastering: **${session.achievements.map(a => `${a.subtopic} in ${a.topic}`).join(', ')}**!`);
  }
  return recs.length ? recs : [`Continue exploring topics that spark your curiosity, ${session.studentName}!`];
};

const generateNextSteps = session => {
  if (session.strugglingAreas?.length > 0) {
    const lastStruggle = session.strugglingAreas[session.strugglingAreas.length - 1];
    return [`You could use extra practice on **${lastStruggle}**. Let's focus more on this next time!`];
  }
  return ['Keep exploring and practicing what interests you most! Every question makes you smarter!'];
};

// --- Core AI Response Generation ---
async function generateAIResponse(sessionId, userMessage, res) {
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  session.messages.push({ role: 'user', content: userMessage, timestamp: Date.now() });
  session.lastActivity = Date.now();

  // Check foundational skills
  let detectedFoundationalIssue = checkFoundationalSkills(userMessage, session);
  if (session.needsFoundationalReview?.skill === 'counting') {
    const countingMasteryRegex = /(one two three four five six seven eight nine ten)/;
    if (countingMasteryRegex.test(userMessage.toLowerCase())) {
      console.log(`✅ Session ${sessionId.slice(-6)}: Counting mastered. Returning to original problem.`);
      session.needsFoundationalReview = null;
    }
  } else if (detectedFoundationalIssue) {
    session.needsFoundationalReview = detectedFoundationalIssue;
    console.log(`⚠️ Session ${sessionId.slice(-6)}: Foundational skill issue: ${detectedFoundationalIssue.skill}`);
  }

  const { subject: userSubject, subtopic: userSubtopic } = classifySubject(userMessage);
  const recentMessages = session.messages.filter(m => m.role !== 'system').slice(-5);
  
  const messagesToSend = [
    { 
      role: 'system', 
      content: getTutorSystemPrompt(
        session.grade,
        session.studentName,
        session.difficultyLevel,
        session.needsFoundationalReview,
        userSubject === 'reading'
      )
    },
    ...recentMessages
  ];

  try {
    let maxTokens = getMaxTokensForGrade(session.grade);
    if (userMessage.toLowerCase().includes('story')) {
      maxTokens = Math.min(maxTokens * 2, 300);
    }

    const adjustedTemperature = session.difficultyLevel < 0.3 ? 0.5 : 
                               (session.difficultyLevel > 0.7 ? 0.8 : config.GPT_TEMPERATURE);

    const completion = await openai.chat.completions.create({
      model: config.GPT_MODEL,
      messages: messagesToSend,
      max_tokens: maxTokens,
      temperature: adjustedTemperature,
      presence_penalty: config.GPT_PRESENCE_PENALTY,
      frequency_penalty: config.GPT_FREQUENCY_PENALTY,
      stop: ["\n\n", "Additionally:", "Furthermore:", "Moreover:"]
    });

    let aiText = completion.choices[0].message.content.trim();
    session.messages.push({ role: 'assistant', content: aiText, timestamp: Date.now() });

    // Update session tracking
    if (userSubject) {
      session.topicsDiscussed.add(userSubject);
      session.currentTopic = userSubject;
      session.currentSubtopic = userSubtopic;
      session.topicBreakdown[userSubject] = session.topicBreakdown[userSubject] || {};
      session.topicBreakdown[userSubject][userSubtopic] = 
        (session.topicBreakdown[userSubject][userSubtopic] || 0) + 1;
    }

    // Adjust difficulty based on response
    const lastUserContent = userMessage.toLowerCase();
    const passiveResponses = ["i don't know", "i dunno", "tell me", "what is the answer"];
    if (passiveResponses.some(phrase => lastUserContent.includes(phrase))) {
      session.difficultyLevel = Math.max(0.1, session.difficultyLevel - 0.1);
    } else if (aiText.length > 50 && !aiText.includes("wrong") && !session.needsFoundationalReview) {
      session.difficultyLevel = Math.min(0.9, session.difficultyLevel + 0.05);
    }

    // Handle reading word extraction
    let messageText = aiText;
    let readingWord = null;
    try {
      const maybeJson = JSON.parse(messageText);
      if (maybeJson?.READING_WORD) {
        messageText = maybeJson.message;
        readingWord = maybeJson.READING_WORD;
      }
    } catch (e) { /* Not JSON; keep as regular text */ }

    res.json({
      response: messageText,
      readingWord: readingWord,
      subject: userSubject,
      suggestions: generateDynamicSuggestions(session),
      encouragement: generateEncouragement(),
      status: 'success',
      sessionStats: {
        totalWarnings: session.totalWarnings,
        topicsDiscussed: Array.from(session.topicsDiscussed)
      }
    });

  } catch (error) {
    console.error(`❌ Error processing chat for session ${sessionId.slice(-6)}:`, error.message);
    res.status(500).json({
      error: 'Failed to process message. Please try again.',
      fallback: `Oops! My brain had a hiccup. No worries, ${session.studentName}! Can you tell me again what you're curious about?`
    });
  }
}

// --- API Routes ---
app.post('/api/session/start', (req, res) => {
  const { studentName, grade } = req.body;

  if (!studentName || !config.VALID_GRADES.includes(grade)) {
    return res.status(400).json({ error: 'Student name and valid grade (PreK-12) are required.' });
  }

  const sessionId = generateSessionId();
  const newSession = createSessionObject(sessionId, studentName, grade);
  sessions.set(sessionId, newSession);

  console.log(`✨ New session: ${sessionId.slice(-6)} for ${studentName} (Grade ${grade})`);

  res.status(201).json({
    sessionId,
    welcomeMessage: generateWelcomeMessage(studentName, grade),
    suggestions: generateSafeSuggestions(grade),
    studentName,
    grade
  });
});

app.post('/api/chat', async (req, res) => {
  const { sessionId, userMessage } = req.body;

  if (!sessionId || !userMessage) {
    return res.status(400).json({ error: 'Session ID and user message are required.' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found. Please start a new session.' });
  }

  // Content moderation
  const inappropriate = containsInappropriateContent(userMessage);
  if (inappropriate.inappropriate) {
    session.totalWarnings++;
    return res.json(getInappropriateResponse(inappropriate.category, session));
  }

  await generateAIResponse(sessionId, userMessage, res);
});

app.get('/api/session/:sessionId/summary', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    const duration = Math.floor((Date.now() - session.startTime) / 60000);

    res.json({
      duration: duration > 0 ? `${duration} minutes` : 'Less than a minute',
      totalWarnings: session.totalWarnings,
      topicsExplored: buildPersonalizedSummary(session),
      studentName: session.studentName,
      grade: session.grade,
      recommendations: generateRecommendations(session),
      nextSteps: generateNextSteps(session)
    });
  } catch (error) {
    console.error(`❌ Error getting summary:`, error.message);
    res.status(500).json({ error: 'Failed to get session summary.' });
  }
});

app.post('/api/session/:sessionId/end', (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessions.delete(sessionId)) {
      return res.status(404).json({ error: 'Session not found or already ended.' });
    }
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
    duration: Math.floor((Date.now() - session.startTime) / 60000),
    topics: Array.from(session.topicsDiscussed),
    difficultyLevel: session.difficultyLevel
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    activeSessionsInCache: sessions.size,
    uptime: process.uptime()
  });
});

const server = app.listen(config.PORT, () => {
  console.log(`🎓 AI Tutor Backend running on port ${config.PORT}`);
  console.log(`📊 Health check: http://localhost:${config.PORT}/api/health`);
  console.log(`🚀 Ready to help students learn safely!`);
});

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