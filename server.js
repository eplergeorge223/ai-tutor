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
  'painting', 'reading', 'algebra', 'geometry', 'fraction', 'biology', 'physics', 'history', 'government', 'capital',
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

// Enhanced System Prompt Function (improved version)
function getTutorSystemPrompt(grade, studentName, sessionContext = {}) {
    const basePrompt = `
You are an exceptionally patient, encouraging, and kind AI Tutor for ${studentName}, designed to help students think critically and understand concepts deeply.
Your primary goal is to foster a love for learning and build confidence.
Keep replies short, simple, and step-by-step, always appropriate for a ${grade} grade student.

**Core Principles for Every Interaction:**
-   **Guide, Don't Give Answers:** Never directly provide the answer to a question. Instead, ask guiding questions, offer hints, or break down the problem into smaller, manageable steps.
-   **Prioritize Context & Infer Intent:** Pay close attention to the flow of the conversation and the established learning topic. If a word or phrase seems out of place, try your best to understand what ${studentName} *means* based on what we've been discussing. For example, if we're talking about art and ${studentName} says something that sounds like "Payton" but "painting" makes sense in context, assume "painting."
-   **Clarify Gently if Unsure:** If you genuinely cannot understand what ${studentName} means after considering the context, politely ask for clarification. For example: "Could you tell me more about that, ${studentName}?" or "I want to make sure I understand! Can you say that another way?"
-   **Personalize & Encourage:** Use ${studentName}'s name naturally in responses. Celebrate effort and progress, no matter how small. "You're doing great, ${studentName}!" or "That's excellent thinking!"
-   **Simplify Language:** Always use words and concepts a child of their grade level will easily understand. Avoid jargon.
-   **Positive & Patient Tone:** Maintain an upbeat, supportive, and understanding tone. If the student is struggling or gives an incorrect answer, be gentle, rephrase the question, or offer a new approach.
-   **Redirect Gently:** If the student asks something off-topic or inappropriate, gently but firmly redirect them back to an educational topic using positive language. Never engage with non-educational or personal matters.
-   **Build on Previous Learning:** Reference what ${studentName} has already learned or discussed to create connections and reinforce understanding.

**How to Respond When a Student Struggles or Says "I Don't Know":**
-   **Rephrase:** Try asking the question in a different way.
-   **Break It Down:** Divide a complex problem into simpler parts. "Let's try a smaller piece of that first."
-   **Offer a Hint:** "Think about what happens when..." or "Remember when we talked about..."
-   **Provide an Analogy:** Use a simple, relatable example from their everyday life.
-   **Encourage Effort:** "It's okay to not know right away, ${studentName}! Learning is all about trying. What's your best guess?" or "That's a tricky one! Let's think it through together."
-   **Use Visual Learning:** Suggest drawing, counting with fingers, or using objects to help understand.

**Response Length Limits (Strict):**
-   PreK–2: 1–2 very simple sentences. Focus on single concepts.
-   3–5: 2–3 concise sentences.
-   6–8: 3–4 sentences.
-   9–12: 4–5 sentences.

**Learning Engagement Strategies:**
-   Ask "What do you think?" or "What's your guess?" to encourage participation
-   Use real-world connections: "Have you ever seen this happen at home?"
-   Encourage curiosity: "That's a great question! What made you think of that?"
-   Validate attempts: "I can see you're really thinking about this!"
-   Create excitement: "Let's discover something amazing together!"

`.trim();

    const readingDisplayInstruction = `
**Special Instruction for Reading Activities (PreK–2):**
When teaching reading for these grades, you may sometimes present words for reading practice.
For reading activities, you can ask questions like:
- "Can you sound out this word, ${studentName}?"
- "What sounds do you hear in this word?"
- "Let's read this word together!"
Choose age-appropriate words that match their reading level.
Remember to break down words into sounds and celebrate their efforts!
`.trim();

    const examples = `
**Examples of Guiding Questions and Encouragement:**
-   Math: "Let's count 5 plus 5 on your fingers, ${studentName}. What do you get when you put them all together?" (Instead of "The answer is 10.")
-   Reading: "Sound out the first part of this word: 's-u-n'. What word do you hear?" (If they get 'su', "Great start! Now what about 'n'?")
-   Science: "What do you think happens to ice when it gets warm from the sun, ${studentName}? Where does it go?" (Instead of "It melts into water.")
-   Social Studies: "If you were an explorer, what would you need to take on a long journey?" (Instead of listing supplies)
-   Art: "What colors do you think we could mix to make purple?" (Instead of "Red and blue make purple")
-   If struggling: "It looks like you're thinking hard! Let's try drawing a picture to help us with this problem."
-   If incorrect: "Good try, ${studentName}! That's close. Remember when we talked about how addition works? If you have 3 apples and then add 2 more, how many do you have now?"
-   Building confidence: "I love how you're asking questions! That shows you're really thinking like a scientist/mathematician/reader!"

**Subject-Specific Guidance:**
-   Math: Always encourage mental math, finger counting, or drawing for visualization
-   Reading: Focus on phonics, sound blending, and comprehension questions
-   Science: Promote observation, prediction, and simple experiments
-   Social Studies: Connect to their community and family experiences
-   Art/Music: Encourage creativity and self-expression

Stay positive, focused, and always teach the process of thinking, ${studentName}!
    `.trim();

    const gradeGuidelines = {
        'PreK': 'Use very simple words and concepts. Focus on 1-2 sentence replies. Be extra patient and encouraging. Use lots of praise and excitement.',
        'K': 'Simple words, basic ideas. 1–2 sentences. Break down concepts into the smallest steps. Encourage trying and celebrating small wins.',
        '1': 'Easy words, encourage trying different approaches. 1–2 sentences. Rephrase often if needed. Focus on building confidence.',
        '2': 'Build confidence, simple steps. 2 sentences. Guide them to discover the answer. Start introducing "why" questions.',
        '3': 'A bit more detail, still brief. 2–3 sentences. Encourage explaining their thought process. Introduce problem-solving strategies.',
        '4': 'Explain clearly, don\'t ramble. 2–3 sentences. Prompt for reasoning. Help them make connections between ideas.',
        '5': 'Good explanations, stay on topic. 3 sentences. Encourage independent problem-solving. Introduce more complex thinking.',
        '6': 'A little more complex, still short. 3-4 sentences. Ask them to think of examples. Encourage deeper analysis.',
        '7': 'Focused and clear. 3-4 sentences. Challenge them slightly with guiding questions. Promote critical thinking.',
        '8': 'Explain in detail, don\'t overwhelm. 3-4 sentences. Prompt for deeper understanding. Encourage research and exploration.',
        '9': 'Cover fully, be efficient. 4-5 sentences. Encourage asking clarifying questions. Promote independent learning.',
        '10': 'Thorough, but keep it moving. 4-5 sentences. Ask for their prior knowledge. Encourage connecting concepts.',
        '11': 'Go in-depth, stay focused. 4-5 sentences. Help them connect new concepts to old ones. Promote analytical thinking.',
        '12': 'Complete answers, efficient. 4-5 sentences. Encourage real-world application. Prepare for advanced learning.'
    };

    // Add session context for continuity
    let contextualGuidance = '';
    if (sessionContext.topicsDiscussed && sessionContext.topicsDiscussed.length > 0) {
        contextualGuidance = `
**Session Context:**
${studentName} has been exploring: ${sessionContext.topicsDiscussed.join(', ')}
Build on these previous discussions and help make connections between topics.
        `.trim();
    }

    // Only inject reading instruction for early grades
    if (['PreK', 'K', '1', '2'].includes(grade)) {
        return `
${basePrompt}

${readingDisplayInstruction}

${examples}

${gradeGuidelines[grade]}

${contextualGuidance}
        `.trim();
    }

    // All other grades
    return `
${basePrompt}

${examples}

${gradeGuidelines[grade] || gradeGuidelines['K']}

${contextualGuidance}
    `.trim();
}

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
  return level <= 2 ? 50 : level <= 5 ? 80 : level <= 8 ? 100 : 120;
};

function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function fuzzyCorrect(text) {
  return text.split(/\s+/).map(word => {
    if (word.length <= 2) return word;
    
    const lowerWord = word.toLowerCase();
    if (VOCABULARY.some(v => v.toLowerCase() === lowerWord)) return word;
    
    let bestMatch = { word: word, distance: Infinity };
    
    for (const candidate of VOCABULARY) {
      const distance = levenshteinDistance(lowerWord, candidate.toLowerCase());
      if (distance < bestMatch.distance) {
        bestMatch = { word: candidate, distance: distance };
      }
    }
    
    if (bestMatch.distance <= 2 && Math.abs(word.length - bestMatch.word.length) <= 2) {
      return bestMatch.word;
    }
    
    return word;
  }).join(' ');
}

function extractFlashcardData(response) {
  const patterns = [
    {
      regex: /what\s+is\s+(\d+\s*[\+\-\*\/]\s*\d+(?:\s*[\+\-\*\/]\s*\d+)*)/i,
      handler: (match) => {
        const problem = match[1];
        try {
          const answer = eval(problem.replace(/\s/g, ''));
          return { prompt: "What is...", front: problem, back: answer.toString() };
        } catch (e) { return null; }
      }
    },
    {
      regex: /(?:spell|how\s+do\s+you\s+spell)\s+.*["""]?(\w+)["""]?/i,
      handler: (match) => {
        const word = match[1].toLowerCase();
        const spelled = word.split('').join('-');
        return { prompt: "Spell the word:", front: word, back: spelled.toUpperCase() };
      }
    },
    {
      regex: /what\s+letter\s+comes\s+after\s+(\w)/i,
      handler: (match) => {
        const letter = match[1].toUpperCase();
        const nextLetter = String.fromCharCode(letter.charCodeAt(0) + 1);
        return { prompt: "What letter comes after:", front: letter, back: nextLetter };
      }
    },
    {
      regex: /what\s+is\s+the\s+capital\s+of\s+(\w+)/i,
      handler: (match) => {
        const state = match[1];
        const capitals = {
          'california': 'Sacramento', 'texas': 'Austin', 'florida': 'Tallahassee',
          'newyork': 'Albany', 'illinois': 'Springfield'
        };
        const capital = capitals[state.toLowerCase()];
        return capital ? { prompt: "What is the capital of:", front: state, back: capital } : null;
      }
    }
  ];
  
  for (const pattern of patterns) {
    const match = response.match(pattern.regex);
    if (match) {
      const result = pattern.handler(match);
      if (result) return result;
    }
  }
  return null;
}

function extractReadingWord(response, grade) {
  if (!['PreK', 'K', '1', '2'].includes(grade)) return null;
  
  const patterns = [
    /can\s+you\s+read\s+.*word\s+["""]?(\w+)["""]?/i,
    /sound\s+out\s+.*word\s+["""]?(\w+)["""]?/i,
    /try\s+reading\s+["""]?(\w+)["""]?/i
  ];
  
  for (const pattern of patterns) {
    const match = response.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function checkAnswer(userInput, expectedAnswer, originalQuestion) {
  const userClean = userInput.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const expectedClean = expectedAnswer.toString().toLowerCase().replace(/[^\w\s]/g, '').trim();
  
  // Direct match
  if (userClean === expectedClean) return true;
  
  // Handle spelling answers (like "d o g" or "d-o-g")
  if (originalQuestion && typeof originalQuestion === 'string') {
    const spellPattern = userClean.replace(/[\s\-]/g, '');
    const expectedSpell = expectedClean.replace(/[\s\-]/g, '');
    if (spellPattern === expectedSpell) return true;
  }
  
  // Handle math answers
  if (!isNaN(userClean) && !isNaN(expectedClean)) {
    return parseFloat(userClean) === parseFloat(expectedClean);
  }
  
  return false;
}

function generateHint(question, answer, grade) {
  if (typeof question === 'string' && question.length < 8) {
    // Likely a spelling question
    return `Not quite! Let's try again. Can you spell "${question}" letter by letter?`;
  }
  
  if (!isNaN(answer)) {
    // Math question
    return `That's not quite right. Think about it step by step. What's ${question}?`;
  }
  
  return `Good try! Let's think about this together. The answer is ${answer}.`;
}

function smartFuzzyCorrect(text) {
  // Only correct obvious educational terms, leave everything else alone
  const words = text.split(/\s+/);
  return words.map(word => {
    if (word.length <= 3) return word;
    
    // Only correct if it's clearly meant to be an educational term
    for (const vocab of VOCABULARY) {
      if (levenshteinDistance(word.toLowerCase(), vocab.toLowerCase()) <= 1 && 
          Math.abs(word.length - vocab.length) <= 1) {
        return vocab;
      }
    }
    return word;
  }).join(' ');
}

function createFocusedSystemPrompt(session) {
  return `You are a patient, encouraging AI tutor for ${session.studentName}, a ${session.grade} grade student.

CRITICAL RULES:
1. Listen carefully to what the student actually says
2. If they spell something correctly, acknowledge it positively
3. Stay on topic and don't make up information
4. Use simple language appropriate for ${session.grade} grade
5. Be encouraging but don't overwhelm

Current conversation context: ${Array.from(session.topicsDiscussed).join(', ') || 'Getting started'}

Keep responses short and focused. Maximum ${getMaxTokens(session.grade)} tokens.`;
}

function shouldCreateFlashcard(userMessage, aiResponse) {
  const userLower = userMessage.toLowerCase();
  const aiLower = aiResponse.toLowerCase();
  
  // Create flashcard if:
  // 1. User asks how to spell something
  // 2. AI asks a direct question with clear answer
  // 3. Math problem is presented
  
  return (
    userLower.includes('spell') || 
    userLower.includes('how to spell') ||
    /what\s+is\s+\d+/.test(aiLower) ||
    /can\s+you\s+spell/.test(aiLower)
  );
}

const getSuggestions = (grade, topicsDiscussed = []) => {
  const level = parseInt(grade) || 0;
  let baseSuggestions = [];
  
  if (level <= 2) {
    baseSuggestions = ['counting', 'colors', 'simple words', 'animal sounds', 'shapes', 'letters'];
  } else if (level <= 5) {
    baseSuggestions = ['math problems', 'reading stories', 'science experiments', 'animals', 'geography', 'art projects'];
  } else {
    baseSuggestions = ['challenging problems', 'new topics', 'advanced skills', 'deeper exploration', 'research projects', 'critical thinking'];
  }
  
  // Add topic-specific suggestions based on what they've discussed
  if (topicsDiscussed.includes('math')) {
    baseSuggestions.push(level <= 5 ? 'more math puzzles' : 'advanced math concepts');
  }
  if (topicsDiscussed.includes('science')) {
    baseSuggestions.push(level <= 5 ? 'fun experiments' : 'scientific research');
  }
  
  return baseSuggestions.slice(0, 4); // Keep it manageable
};

const createSession = (id, name, grade, subjects) => ({
  id, 
  studentName: name || 'Student', 
  grade: grade || 'K', 
  subjects: subjects || [],
  startTime: new Date(), 
  lastActivity: Date.now(), 
  totalWarnings: 0,
  messages: [],
  topicsDiscussed: new Set(), 
  conversationContext: [],
  lastQuestion: null,
  expectedAnswer: null,
  learningStreak: 0,
  encouragementLevel: 0
});

// Initialize session with enhanced system prompt
const initializeSession = (session) => {
  const systemPrompt = getTutorSystemPrompt(
    session.grade, 
    session.studentName, 
    {
      topicsDiscussed: Array.from(session.topicsDiscussed),
      sessionDuration: Date.now() - session.startTime.getTime()
    }
  );
  
  session.messages = [
    { role: 'system', content: systemPrompt, timestamp: new Date() }
  ];
};

// Routes
app.post('/api/session/start', (req, res) => {
  try {
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2);
    const { studentName, grade, subjects } = req.body;
    
    const validatedGrade = config.VALID_GRADES.includes(grade) ? grade : 'K';
    const validatedName = studentName?.trim() || 'Student';
    
    const session = createSession(sessionId, validatedName, validatedGrade, subjects);
    initializeSession(session);
    sessions.set(sessionId, session);
    
    console.log(`🚀 Session started: ${sessionId.slice(-6)}, ${validatedName}, Grade: ${validatedGrade}`);
    
    res.json({
      sessionId,
      status: 'success',
      sessionInfo: { 
        studentName: validatedName, 
        grade: validatedGrade, 
        startTime: session.startTime,
        welcomeMessage: `Hi ${validatedName}! I'm so excited to learn with you today! What would you like to explore?`
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

    // Raw message for logging and processing
    const rawMessage = message.trim();
    
    // Check for inappropriate content FIRST, before any processing
    if (containsInappropriate(rawMessage)) {
      session.totalWarnings++;
      console.warn(`🚨 Inappropriate content in session ${sessionId.slice(-6)}: "${rawMessage}"`);
      
      // Clear any pending flashcard state
      session.lastQuestion = null;
      session.expectedAnswer = null;
      
      return res.json({
        response: `Let's use kind words when we're learning together, ${session.studentName}! What would you like to explore?`,
        suggestions: getSuggestions(session.grade, Array.from(session.topicsDiscussed)),
        status: 'redirected',
        flashcardMode: false
      });
    }

    // Handle flashcard/expected answer logic
    if (session.expectedAnswer) {
      const isCorrect = checkAnswer(rawMessage, session.expectedAnswer, session.lastQuestion);
      
      if (isCorrect) {
        session.lastQuestion = null;
        session.expectedAnswer = null;
        session.learningStreak++;
        
        const encouragement = session.learningStreak > 3 ? 
          `Amazing! You're on a roll, ${session.studentName}! ` : 
          `That's correct! Great job, ${session.studentName}! `;
        
        return res.json({
          response: encouragement + `You're really getting the hang of this!`,
          status: 'success',
          learningStreak: session.learningStreak,
          flashcardMode: false
        });
      } else {
        // Give them another chance if it's close
        const hint = generateHint(session.lastQuestion, session.expectedAnswer, session.grade);
        return res.json({
          response: hint,
          status: 'hint',
          flashcardMode: true,
          flashcard: {
            front: session.lastQuestion,
            back: session.expectedAnswer
          }
        });
      }
    }

    // Handle special cases
    if (/^can you hear me\??$/i.test(rawMessage)) {
      return res.json({
        response: `Yes! I can hear you loud and clear, ${session.studentName}! What would you like to learn about today?`,
        suggestions: getSuggestions(session.grade, Array.from(session.topicsDiscussed)),
        status: 'success'
      });
    }

    // Handle very short/unclear messages
    if (rawMessage.length < 3 || /^(um+|uh+|er+|hmm+)$/i.test(rawMessage)) {
      return res.json({
        response: `Take your time, ${session.studentName}! I'm here when you're ready to explore something exciting!`,
        suggestions: getSuggestions(session.grade, Array.from(session.topicsDiscussed)),
        status: 'listening'
      });
    }

    // Apply minimal fuzzy correction ONLY to educational terms
    let processedMessage = rawMessage;
    try {
      // Only apply fuzzy correction to individual words, not the whole message
      processedMessage = smartFuzzyCorrect(rawMessage);
    } catch (error) {
      console.warn('⚠️ Fuzzy correction failed, using original message:', error.message);
      processedMessage = rawMessage;
    }

    // Create a focused system prompt
    const systemPrompt = createFocusedSystemPrompt(session);
    
    // Build conversation context
    const conversationMessages = [
      { role: 'system', content: systemPrompt },
      ...session.messages.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: processedMessage }
    ];

    // Add user message to session
    session.messages.push({ role: 'user', content: processedMessage, timestamp: new Date() });

    // Generate AI response
    const completion = await openai.chat.completions.create({
      model: config.GPT_MODEL,
      messages: conversationMessages,
      max_tokens: getMaxTokens(session.grade),
      temperature: config.GPT_TEMPERATURE,
      stop: ["\n\n", "Additionally,", "Furthermore,", "Moreover,"]
    });

    let aiResponse = completion.choices[0].message.content.trim();

    // Check AI response for inappropriate content
    if (containsInappropriate(aiResponse)) {
      session.totalWarnings++;
      aiResponse = `I'm here to help you learn amazing things, ${session.studentName}! What exciting topic would you like to explore today?`;
    }

    // Add AI response to session
    session.messages.push({ role: 'assistant', content: aiResponse, timestamp: new Date() });

    // Track topics
    const subject = classifySubject(rawMessage);
    if (subject) session.topicsDiscussed.add(subject);

    // Keep conversation manageable
    if (session.messages.length > 12) {
      session.messages = session.messages.slice(-10);
    }

    // Prepare response
    const responseData = {
      response: aiResponse,
      subject,
      suggestions: getSuggestions(session.grade, Array.from(session.topicsDiscussed)),
      status: 'success',
      sessionStats: {
        totalWarnings: session.totalWarnings,
        topicsDiscussed: Array.from(session.topicsDiscussed),
        learningStreak: session.learningStreak
      }
    };

    // Handle flashcard generation more intelligently
    const flashcardData = extractFlashcardData(aiResponse);
    if (flashcardData && shouldCreateFlashcard(rawMessage, aiResponse)) {
      responseData.flashcard = flashcardData;
      responseData.flashcardMode = true;
      session.lastQuestion = flashcardData.front;
      session.expectedAnswer = flashcardData.back;
    } else {
      responseData.flashcardMode = false;
    }

    // Check for reading word (early grades only)
    const readingWord = extractReadingWord(aiResponse, session.grade);
    if (readingWord) {
      responseData.readingWord = readingWord;
    }

    res.json(responseData);

  } catch (error) {
    console.error('❌ Chat error:', error.message);
    res.status(500).json({
      error: 'Failed to process message',
      fallback: `I'm having trouble right now, but I'm here to help you learn amazing things!`
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