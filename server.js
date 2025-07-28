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
      // Log a more descriptive message before cleaning up the session
      const studentInfo = sess.studentName ? ` for ${sess.studentName}` : '';
      console.log(`🧹 Cleaning expired session ${id.slice(-6)}${studentInfo}`);
      sessions.delete(id);
    }
  }
}, config.CLEANUP_INTERVAL);

// --- Helper Functions ---
const capitalize = str => str.charAt(0).toUpperCase() + str.slice(1);
const generateSessionId = () => Date.now().toString(36) + Math.random().toString(36).substr(2);

// Add this new object near the top of your file, perhaps just below the `config` object
const commonForbiddenWords = {
  veryYoung: ['elements', 'because', 'however', 'different', 'important', 'understand'],
  young: ['elements', 'components', 'analyze', 'determine', 'characteristics', 'properties'],
  mid: ['analyze', 'synthesize', 'evaluate', 'complex'],
};

// Fully grade-aware guidelines
const gradeGuidelines = {
  PreK: {
    maxSentences: 1,
    vocabulary: 'Use only very simple words like "big", "red", "happy". NO complex words.',
    concepts: 'Only basic colors, shapes, animals, counting 1–3.',
    forbidden: commonForbiddenWords.veryYoung,
  },
  K: {
    maxSentences: 1,
    vocabulary: 'Simple 1–2 syllable words. Avoid "difficult", "understand", "explain".',
    concepts: 'Counting to 10, letters A–Z, simple animals and colors.',
    forbidden: commonForbiddenWords.young,
  },
  '1': {
    maxSentences: 2,
    vocabulary: 'Short, common words. Say "parts" not "elements", "look at" not "examine".',
    concepts: 'Simple addition, basic reading, familiar animals and objects.',
    forbidden: commonForbiddenWords.young,
  },
  '2': {
    maxSentences: 2,
    vocabulary: 'Common everyday words. Say "things" not "elements", "find out" not "determine".',
    concepts: 'Basic math facts, simple stories, weather, family.',
    forbidden: commonForbiddenWords.young,
  },
  '3': {
    maxSentences: 3,
    vocabulary: 'Grade 3 reading level. Still avoid academic jargon.',
    concepts: 'Multiplication basics, chapter books, simple science.',
    forbidden: commonForbiddenWords.mid,
  },
  '4': {
    maxSentences: 4,
    vocabulary: 'Grade 4 level. Can use "parts" but not "elements" or "components".',
    concepts: 'Multi-step problems, longer stories, basic science concepts.',
    forbidden: commonForbiddenWords.mid,
  },
  '5': {
    maxSentences: 4,
    vocabulary: 'Grade 5 level. Introduce some academic terms carefully.',
    concepts: 'Fractions, research projects, earth science.',
    forbidden: ['synthesize', 'evaluate', 'critique'],
  },
  '6': {
    maxSentences: 5,
    vocabulary: 'Grade 6 level. You can use more formal terms but keep it clear.',
    concepts: 'Negative numbers, paragraph summaries, life science.',
    forbidden: [],
  },
  '7': {
    maxSentences: 6,
    vocabulary: 'Grade 7 level. Use middle-school appropriate words.',
    concepts: 'Algebra intro, novel analysis, basic physics.',
    forbidden: [],
  },
  '8': {
    maxSentences: 6,
    vocabulary: 'Grade 8 level. Academic tone okay, but stay concise.',
    concepts: 'Linear equations, essay structure, biology.',
    forbidden: [],
  },
  '9': {
    maxSentences: 7,
    vocabulary: 'Grade 9 level. You can introduce more specialized terms.',
    concepts: 'Geometry, literature themes, chemistry basics.',
    forbidden: [],
  },
  '10': {
    maxSentences: 8,
    vocabulary: 'Grade 10 level. College-prep vocabulary acceptable.',
    concepts: 'Quadratics, poetry analysis, physics formulas.',
    forbidden: [],
  },
  '11': {
    maxSentences: 8,
    vocabulary: 'Grade 11 level. Academic writing style okay.',
    concepts: 'Pre-calculus, research methods, chemistry reactions.',
    forbidden: [],
  },
  '12': {
    maxSentences: 10,
    vocabulary: 'Grade 12 level. You can use higher-ed terminology.',
    concepts: 'Calculus, rhetorical analysis, advanced science.',
    forbidden: [],
  }
};

// --- ENHANCEMENT: Use an object lookup for token limits for a cleaner, more scalable approach. ---
const gradeTokenLimits = {
  'PreK': 20,   
  'K': 30,   
  '1': 35,   
  '2': 45,   
  '3': 60,   
  '4': 80,   
  '5': 80,   
  '6': 90,   
  '7': 100,  
  '8': 100,  
  '9': 110,  
  '10': 120,  
  '11': 120,  
  '12': 150
};
const getMaxTokensForGrade = grade => gradeTokenLimits[grade] || 100;

// After-school tutoring system prompt with natural, warm feel
const getTutorSystemPrompt = (grade, studentName, difficultyLevel = 0.5, needsFoundationalReview = null, readingTask = false) => {
  const guidelines = gradeGuidelines[grade] || gradeGuidelines.K;
  const isVeryYoung = ['PreK', 'K', '1', '2'].includes(grade);
  
  let personalizedSupport = '';
  if (difficultyLevel < 0.3) {
    personalizedSupport = `${studentName} seems to need extra help today. Go slower, use simpler words, and give lots of encouragement.`;
  } else if (difficultyLevel > 0.7) {
    personalizedSupport = `${studentName} is doing great today! You can challenge them a bit more, but keep it age-appropriate.`;
  } else {
    personalizedSupport = `${studentName} is making steady progress. Keep up the supportive, patient approach.`;
  }

  const foundationalReview = needsFoundationalReview?.skill === 'counting'
    ? `${studentName} needs to practice counting first. Make it fun - count fingers, toys, or snacks before going back to the main problem.`
    : '';

  const readingInstruction = isVeryYoung && readingTask 
    ? 'For reading: reply in JSON {"message":"...","READING_WORD":"word"} (do NOT spell word in message)' 
    : '';

  let interactionStyle = '';
  if (isVeryYoung) {
    interactionStyle = `
You're like a patient after-school tutor working one-on-one with ${studentName}:
- Use simple words they definitely know
- Keep responses to ${guidelines.maxSentences} sentence${guidelines.maxSentences > 1 ? 's' : ''} max
- Ask one easy question to guide them
- Be warm and encouraging like you've been working together
- Say things like "Good job!" or "Let's try this together!"
- Avoid words like: ${guidelines.forbidden?.join(', ')}`;
  } else {
    interactionStyle = `
You're ${studentName}'s after-school tutor who knows them well:
- Keep responses brief but conversational 
- Guide them to discover answers, don't give them away
- Match their energy - if they're excited, be excited too
- Use encouraging phrases that feel natural`;
  }

  return `You are ${studentName}'s personal after-school tutor. They're in grade ${grade} and you've been working together.

${personalizedSupport}

${interactionStyle}

${foundationalReview}
${readingInstruction}

For any request to recite a song or a sequence (like the ABCs or counting), you should provide the full, complete response in a single conversational turn. Do not ask for confirmation or try to make it a dialogue. Just provide the complete lyrics or sequence. For example, if asked "sing the ABCs", just respond with the lyrics immediately.
For simple math questions, never give the final answer. Instead, ask a question to help the student think through the problem step-by-step. For example, if asked "2 + 3", you could respond with "What do you get when you start with 2 and then add 3 more?".

Remember: This feels like a cozy after-school tutoring session, not a formal classroom. Be warm, patient, and keep things simple for grade ${grade}.`.trim();
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

// Warm after-school tutoring welcome messages
const generateWelcomeMessage = (studentName, grade) => {
  const messages = {
    PreK: `Hi ${studentName}! Ready to play and learn together?`,
    K: `Hey ${studentName}! What do you want to work on today?`,
    '1': `Hi there, ${studentName}! What should we practice together?`,
    '2': `Hello ${studentName}! What are you excited to learn about today?`,
    '3': `Hey ${studentName}! What caught your interest today at school?`,
    '4': `Hi ${studentName}! Ready for some fun learning time?`,
    '5': `Hey there, ${studentName}! What's on your mind to explore today?`
  };
  return messages[grade] || `Hi ${studentName}! Good to see you again. What should we work on?`;
};

const generateSafeSuggestions = (grade, forceGeneral = false) => {
  const gradeSpecific = {
    PreK: ['Let\'s count your toys!', 'What colors do you see?', 'Can you make animal sounds?'],
    K: ['Want to practice your letters?', 'Let\'s count to 10 together!', 'Tell me about your favorite animal!'],
    '1': ['How about some reading practice?', 'Want to try some adding?', 'Let\'s talk about your day!'],
    '2': ['Ready for a story?', 'Want to practice math?', 'Tell me something cool you learned!'],
    '3': ['What\'s something you\'re curious about?', 'Want to work on that math homework?', 'How about we read together?'],
    '4': ['What subject do you want help with?', 'Want to try a fun challenge?', 'Tell me about your favorite book!'],
    '5': ['What\'s been tricky for you lately?', 'Want to explore something new?', 'How about some problem solving?']
  };

  const general = [
    'What did you learn at school today?',
    'Want to try something fun?',
    'Tell me what you\'re thinking about!',
    'What sounds interesting to you?',
    'How about we practice together?',
    'What would you like help with?'
  ].sort(() => 0.5 - Math.random());

  if (forceGeneral || !gradeSpecific[grade]) return general.slice(0, 3);

  return gradeSpecific[grade];
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
  const contextualSuggestions = {
    math: {
      PreK: ["Let's count more things!", "Want to find shapes?", "How about colors and numbers?"],
      K: ["Try counting something else!", "Want to add with your fingers?", "Let's find numbers around us!"],
      '1': ["Want to try another math problem?", "How about counting by 2s?", "Let's practice adding!"],
      '2': ["Ready for a harder one?", "Want to try subtraction?", "How about a word problem?"],
      default: ["Want to try another approach?", "How about a different type of problem?", "Ready for the next challenge?"]
    },
    reading: {
      PreK: ["Let's find more letters!", "Want to rhyme some words?", "How about picture stories?"],
      K: ["Want to read another word?", "Let's find letters in your name!", "How about a simple book?"],
      '1': ["Want to try reading together?", "How about sounding out words?", "Let's read a short story!"],
      '2': ["Ready for a longer story?", "Want to talk about characters?", "How about new vocabulary?"],
      default: ["Want to read something different?", "How about discussing what we read?", "Ready for the next chapter?"]
    },
    science: {
      PreK: ["Let's explore more animals!", "Want to talk about weather?", "How about plants?"],
      K: ["Want to learn about different animals?", "Let's talk about the sky!", "How about our bodies?"],
      default: ["Want to try an experiment?", "How about exploring nature?", "Let's ask more questions!"]
    }
  };

  const topic = session.currentTopic;
  const grade = session.grade;
  
  if (topic && contextualSuggestions[topic]) {
    const gradeSuggestions = contextualSuggestions[topic][grade] || contextualSuggestions[topic].default;
    if (gradeSuggestions) {
      return [...gradeSuggestions.slice(0, 2), "What else interests you?"];
    }
  }
  
  return generateSafeSuggestions(session.grade, true);
};

const generateEncouragement = (grade = 'K') => {
  const encouragements = {
    PreK: ["You're doing great!", "Good job!", "I'm proud of you!", "You're so smart!", "Keep trying!"],
    K: ["Nice work!", "You got it!", "Great thinking!", "You're awesome!", "Way to go!"],
    '1': ["Excellent!", "You're getting better!", "That's right!", "Good for you!", "Keep it up!"],
    '2': ["Fantastic work!", "You're really learning!", "That was smart!", "Great job thinking!", "You're improving!"],
    default: ["Great work!", "You're doing well!", "Nice thinking!", "Keep going!", "Good effort!"]
  };
  
  const gradeEncouragements = encouragements[grade] || encouragements.default;
  return gradeEncouragements[Math.floor(Math.random() * gradeEncouragements.length)];
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

// Post-processing to catch inappropriate vocabulary for young grades
const filterResponseForGrade = (response, grade) => {
  const isVeryYoung = ['PreK', 'K', '1', '2'].includes(grade);
  if (!isVeryYoung) return response;

  const guidelines = gradeGuidelines[grade];
  if (!guidelines?.forbidden) return response;

  let filtered = response;
  
  const replacements = {
    'elements': 'things',
    'components': 'parts',
    'analyze': 'look at',
    'examine': 'look at',
    'determine': 'find out',
    'characteristics': 'what it looks like',
    'properties': 'what it does',
    'understand': 'know',
    'explain': 'tell me',
    'because': 'so',
    'however': 'but',
    'different': 'not the same',
    'important': 'special'
  };

  for (const [complex, simple] of Object.entries(replacements)) {
    const regex = new RegExp(`\\b${complex}\\b`, 'gi');
    filtered = filtered.replace(regex, simple);
  }

  return filtered;
};

async function generateAIResponse(sessionId, userMessage, res) {
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  session.messages.push({ role: 'user', content: userMessage, timestamp: Date.now() });
  session.lastActivity = Date.now();

  const detectedFoundationalIssue = checkFoundationalSkills(userMessage, session);
  if (session.needsFoundationalReview?.skill === 'counting') {
    const countingMasteryRegex = /(one two three four five six seven eight nine ten)/;
    if (countingMasteryRegex.test(userMessage.toLowerCase())) {
      session.needsFoundationalReview = null;
    }
  } else if (detectedFoundationalIssue) {
    session.needsFoundationalReview = detectedFoundationalIssue;
  }

  const { subject: userSubject, subtopic: userSubtopic } = classifySubject(userMessage);
  const recentMessages = session.messages.filter(m => m.role !== 'system').slice(-3);
  
  const baseMaxTokens = getMaxTokensForGrade(session.grade);
  const baseMaxSentences = gradeGuidelines[session.grade]?.maxSentences;
  let maxTokens = baseMaxTokens;
  let maxSentences = baseMaxSentences;
  
  const lowerUserMessage = userMessage.toLowerCase();
  const isSpecialRequest = lowerUserMessage.includes('abc') || lowerUserMessage.includes('alphabet') || lowerUserMessage.includes('count to');

  if (isSpecialRequest) {
      maxTokens = 150; 
      maxSentences = 10;
  }

  const messagesToSend = [
    {
      role: 'system',
      content: getTutorSystemPrompt(session.grade, session.studentName, session.difficultyLevel, session.needsFoundationalReview, userSubject === 'reading')
    },
    ...recentMessages
  ];

  try {
    const isVeryYoung = ['PreK', 'K', '1', '2'].includes(session.grade);
    const adjustedTemperature = isVeryYoung
      ? 0.3
      : session.difficultyLevel < 0.3
        ? 0.4
        : session.difficultyLevel > 0.7
          ? 0.6
          : 0.5;

    const allStops = [
      "\n\n",
      "Additionally:",
      "Furthermore:",
      "Moreover:",
      "However,",
      "Therefore,",
      "In conclusion,"
    ];
    const stops = allStops.slice(0, 4);

    const completion = await openai.chat.completions.create({
      model: config.GPT_MODEL,
      messages: messagesToSend,
      max_tokens: maxTokens,
      temperature: adjustedTemperature,
      presence_penalty: config.GPT_PRESENCE_PENALTY,
      frequency_penalty: config.GPT_FREQUENCY_PENALTY,
      stop: stops
    });

    let aiText = completion.choices[0].message.content.trim();

    aiText = filterResponseForGrade(aiText, session.grade);

    if (maxSentences) {
      const sentences = aiText.split(/[.!?]+/).filter(s => s.trim());
      if (sentences.length > maxSentences) {
        aiText = sentences.slice(0, maxSentences).join('. ').trim() + '.';
      }
    }

    session.messages.push({ role: 'assistant', content: aiText, timestamp: Date.now() });

    if (userSubject) {
      session.topicsDiscussed.add(userSubject);
      session.currentTopic = userSubject;
      session.currentSubtopic = userSubtopic;
      session.topicBreakdown[userSubject] = session.topicBreakdown[userSubject] || {};
      session.topicBreakdown[userSubject][userSubtopic] =
        (session.topicBreakdown[userSubject][userSubtopic] || 0) + 1;
    }

    const lowerInput = userMessage.toLowerCase();
    const passivePhrases = ["i don't know", "i dunno", "tell me", "what is the answer"];
    if (passivePhrases.some(phrase => lowerInput.includes(phrase))) {
      session.difficultyLevel = Math.max(0.1, session.difficultyLevel - 0.1);
    } else if (aiText.length > 20 && !aiText.includes("wrong") && !session.needsFoundationalReview) {
      session.difficultyLevel = Math.min(0.9, session.difficultyLevel + 0.05);
    }

    let readingWord = null;
    let messageText = aiText;
    try {
      const maybeJson = JSON.parse(aiText);
      if (maybeJson?.READING_WORD) {
        messageText = maybeJson.message;
        readingWord = maybeJson.READING_WORD;
      }
    } catch (_) {
    }

    res.json({
      response: messageText,
      readingWord,
      subject: userSubject,
      suggestions: generateDynamicSuggestions(session),
      encouragement: generateEncouragement(session.grade),
      status: 'success',
      sessionStats: {
        totalWarnings: session.totalWarnings,
        topicsDiscussed: Array.from(session.topicsDiscussed)
      }
    });
  } catch (error) {
    console.error(`Error in session ${sessionId.slice(-6)}:`, error.message);
    res.status(500).json({
      error: 'Failed to process message. Please try again.',
      fallback: `Oops! Can you ask me again, ${session.studentName}?`
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