const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const helmet = require('helmet'); // Added helmet

// --- Configuration Constants ---
const config = {
  PORT: process.env.PORT || 3000,
  SESSION_TTL: 45 * 60 * 1000, // 45 minutes of inactivity
  CLEANUP_INTERVAL: 5 * 60 * 1000, // Check for expired sessions every 5 minutes
  MAX_SESSION_INTERACTIONS: 100, // Max interactions per session before a soft limit
  GPT_MODEL: 'gpt-4o-mini',
  GPT_TEMPERATURE: 0.8, // Slightly higher for more engaging responses
  GPT_PRESENCE_PENALTY: 0.3, // Encourage more varied responses
  GPT_FREQUENCY_PENALTY: 0.2, // Penalize frequent tokens
  VALID_GRADES: ['PreK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
  // Content filtering words (can be expanded/externalized)
  INAPPROPRIATE_TOPICS: {
    sexual: ['breast', 'condom', 'erotic', 'intercourse', 'masturbate', 'naked', 'orgasm', 'penis', 'porn', 'pregnancy', 'sex', 'sexual', 'vagina'],
    violence: ['abuse', 'blood', 'bomb', 'death', 'gun', 'hurt', 'kill', 'knife', 'murder', 'pain', 'suicide', 'violence', 'weapon'],
    profanity: ['ass', 'bastard', 'bitch', 'cock', 'crap', 'damn', 'dick', 'fuck', 'hell', 'piss', 'pussy', 'shit'],
    drugs: ['alcohol', 'beer', 'cigarette', 'cocaine', 'drugs', 'heroin', 'high', 'marijuana', 'smoking', 'weed', 'wine'],
    inappropriate: ['dumb', 'fat', 'hate', 'idiot', 'loser', 'retard', 'stupid', 'ugly']
  }
};

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ FATAL: Missing OPENAI_API_KEY environment variable. Please set it in your .env file.');
  process.exit(1);
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '4kb' }));
app.use(helmet({ contentSecurityPolicy: false }));

// Rate limiting - more generous for educational use
app.use(rateLimit({
  windowMs: 60_000,
  max: 50,
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

// Cleanup expired sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.lastActivity > config.SESSION_TTL) {
      console.log(`🧹 Cleaning up expired session ${id.slice(-6)}. Inactivity: ${((now - sess.lastActivity) / 1000 / 60).toFixed(1)} minutes.`);
      sessions.delete(id);
    }
  }
}, config.CLEANUP_INTERVAL);

// Check for inappropriate content
function containsInappropriateContent(text) {
  const lowerText = text.toLowerCase();
  for (const [category, words] of Object.entries(config.INAPPROPRIATE_TOPICS)) {
    for (const word of words) {
const regex = new RegExp(`\\b${word}\\b`, 'i');
if (regex.test(lowerText)) {
        return { inappropriate: true, category, word };
      }
    }
  }
  return { inappropriate: false };
}

// Generate session ID
function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Enhanced AI Tutor system prompt with stronger content filtering
function getTutorSystemPrompt(grade, studentName) {
  const basePrompt = `You are ${studentName}'s AI Tutor, a friendly, encouraging, and knowledgeable educational assistant. Your personality should be:

- Warm, patient, and encouraging
- Age-appropriate in language and explanations
- Curious and enthusiastic about learning
- Supportive when students struggle
- Celebratory of achievements and progress

CRITICAL SAFETY RULES:
- NEVER discuss inappropriate topics including: violence, weapons, sexual content, drugs, or adult themes
- If asked about inappropriate topics, redirect to age-appropriate learning: "That's not something we talk about in our learning time! Let's explore something educational instead. What subject interests you?"
- If student uses inappropriate language, gently correct: "Let's use kind words in our learning space. What would you like to learn about today?"
- Always maintain a positive, educational focus
- If student is rude or disrespectful, stay calm and redirect: "I'm here to help you learn amazing things! What topic would you like to explore?"

ENGAGEMENT RULES:
- Ask follow-up questions to keep the conversation flowing
- Share interesting facts and connections
- Use storytelling when appropriate
- Encourage curiosity and critical thinking
- Make learning feel like an adventure
- Connect topics to real-world examples the student can relate to

STORY LENGTH GUIDELINES:
- Short story (2-3 minutes): 3-4 paragraphs
- Medium story (5 minutes): 6-8 paragraphs with detailed descriptions
- Long story (10+ minutes): 10+ paragraphs with character development and plot

Guidelines:
- Ask follow-up questions to gauge understanding
- Break complex topics into simple, digestible parts
- Use analogies and examples kids can relate to
- Encourage critical thinking with gentle prompts
- Adapt your explanations based on the student's responses
- Keep responses conversational and engaging
- Always be positive and supportive
- DO NOT use emojis in your responses as they will be read aloud by text-to-speech
- Remember previous topics discussed in this session and build upon them`;

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

  return `${basePrompt}\n\nGrade-specific guidance: ${gradeGuideline}\n\nRemember: You're not just answering questions, you're fostering a love of learning while keeping everything safe and appropriate!`;
}

// Enhanced session structure
function createSession(sessionId, studentName, grade, subjects) {
    const initialSystemMessageContent = getTutorSystemPrompt(grade, studentName);
    return {
        id: sessionId,
        studentName: studentName || 'Student',
        grade: grade || 'K',
        subjects: subjects || [],
        startTime: new Date(),
        lastActivity: Date.now(),
        messages: [{ role: 'system', content: initialSystemMessageContent, timestamp: new Date() }], // Pre-populate with system message
        totalInteractions: 0,
        totalWarnings: 0,
        topicsDiscussed: new Set(),
        currentTopic: null,
        conversationContext: [],
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

    if (typeof studentName !== 'string' || typeof grade !== 'string' || (subjects && !Array.isArray(subjects))) {
  return res.status(400).json({ error: 'Invalid session parameters.' });
}


    // Validate inputs
    const validatedGrade = config.VALID_GRADES.includes(grade) ? grade : 'K';
    const validatedName = studentName && studentName.trim() ? studentName.trim() : 'Student';

    const session = createSession(sessionId, validatedName, validatedGrade, subjects);
    sessions.set(sessionId, session);

    // Generate personalized welcome message
    const welcomeText = generateWelcomeMessage(validatedName, validatedGrade);

    console.log(`🚀 Session started: ID ending in ${sessionId.slice(-6)}, Student: ${validatedName}, Grade: ${validatedGrade}`);

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
    console.error('❌ Error starting session:', error.message);
    res.status(500).json({ error: 'Failed to start session. Please try again.' });
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

// Enhanced chat endpoint with content filtering
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body; // 'context' is no longer directly passed, it's managed internally

    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({ error: 'Invalid or expired session. Please start a new session.' });
    }

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    const session = sessions.get(sessionId);
    session.lastActivity = Date.now();

    if (session.totalInteractions >= config.MAX_SESSION_INTERACTIONS) {
      return res.status(429).json({ error: 'Session interaction limit reached. Please start a new session to continue learning.' });
    }

    // Check for inappropriate content
    const contentCheck = containsInappropriateContent(message);
    if (contentCheck.inappropriate) {
          session.totalWarnings = (session.totalWarnings || 0) + 1;
      const redirectResponse = generateRedirectResponse(contentCheck.category, session);

      // Log the inappropriate attempt
      console.warn(`🚨 SECURITY ALERT: Inappropriate content detected in session ${sessionId.slice(-6)}: "${contentCheck.word}" (Category: ${contentCheck.category}).`);

      return res.json({
        response: redirectResponse,
        subject: null,
        suggestions: generateSafeSuggestions(session.grade),
        encouragement: generateEncouragement(session),
        status: 'redirected'
      });
    }

    console.log(`💬 Chat message received for session ${sessionId.slice(-6)} from ${session.studentName} (Grade: ${session.grade}). Message: "${message.substring(0, Math.min(message.length, 50))}..."`);

    const response = await generateAIResponse(sessionId, message.trim()); // No 'context' param

    // Track topics and learning patterns
    const subject = classifySubject(message);
    if (subject) {
      session.topicsDiscussed.add(subject);
      session.currentTopic = subject;
    }

    // Update conversation context for better suggestions
    session.conversationContext.push({
      message: message,
      topic: subject,
      timestamp: Date.now()
    });

    // Keep only last 5 context items
    if (session.conversationContext.length > 5) {
      session.conversationContext = session.conversationContext.slice(-5);
    }

    res.json({
      response: response.text,
      subject: response.subject,
      suggestions: generateContextualSuggestions(session),
      encouragement: response.encouragement,
      status: 'success',
      sessionStats: {
        totalWarnings: session.totalWarnings || 0,
        topicsDiscussed: Array.from(session.topicsDiscussed)
      }
    });
  } catch (error) {
    console.error(`❌ Error processing chat for session: ${req.body.sessionId ? req.body.sessionId.slice(-6) : 'N/A'}:`, error.message);
    const fallback = generateFallbackResponse(req.body.message || '');
    res.status(500).json({
      error: 'Failed to process message due to an internal error. Please try again.',
      fallback
    });
  }
});

// Generate redirect response for inappropriate content
function generateRedirectResponse(category, session) {
  const redirects = {
    sexual: `That's not something we talk about in our learning time, ${session.studentName}! Let's explore something educational instead. What subject interests you today?`,
    violence: `I'm here to help you learn positive and educational things, ${session.studentName}! What would you like to learn about instead?`,
    profanity: `Let's use kind words in our learning space, ${session.studentName}. What would you like to learn about today?`,
    drugs: `That's not an appropriate topic for our learning time, ${session.studentName}! Let's focus on something educational. What interests you?`,
    inappropriate: `I'm here to help you learn amazing things, ${session.studentName}! What topic would you like to explore today?`
  };
  return redirects[category] || redirects.inappropriate;
}

// Generate safe suggestions for redirected content (randomized)
function generateSafeSuggestions(grade) {
  const generalSuggestions = [
    'Let\'s explore science!',
    'Want to learn about animals?',
    'How about some fun math?',
    'Let\'s read a story together!',
    'What about learning something new?'
  ];
  const gradeSpecific = {
    'PreK': ['Let\'s learn colors!', 'What about shapes?', 'Let\'s sing a song!'],
    'K': ['Let\'s count!', 'What about letters?', 'Let\'s learn animal sounds!'],
    '1': ['Let\'s practice ABCs!', 'How about counting to 100?', 'Tell me about your favorite animal!']
  };

  const currentSuggestions = gradeSpecific[grade] || generalSuggestions;
  // Shuffle and pick 3 unique suggestions
  return currentSuggestions.sort(() => 0.5 - Math.random()).slice(0, 3);
}

// Generate contextual suggestions based on current conversation
function generateContextualSuggestions(session) {
  const currentTopic = session.currentTopic;
  const recentMessagesLower = session.conversationContext.map(c => c.message.toLowerCase()).join(' ');

  // If we have a current topic, generate related suggestions
  if (currentTopic) {
    const topicSuggestions = {
      math: [
        'Let\'s try another math problem!',
        'Want to see math in real life?',
        'How about a fun math challenge?',
        'Let\'s explore different math concepts!'
      ],
      reading: [
        'Let\'s read more together!',
        'Want to learn new vocabulary?',
        'How about writing our own story?',
        'Let\'s practice reading skills!'
      ],
      science: [
        'Let\'s explore more science!',
        'Want to learn about nature?',
        'How about a cool experiment?',
        'Let\'s discover something amazing!'
      ],
      writing: [
        'Let\'s practice writing!',
        'Want to be creative with words?',
        'How about a writing challenge?',
        'Let\'s improve our writing skills!'
      ],
      history: [
        'Let\'s explore more history!',
        'Want to learn about the past?',
        'How about famous historical figures?',
        'Let\'s discover historical events!'
      ],
      art: [
        'Let\'s be creative!',
        'Want to learn about artists?',
        'How about making something?',
        'Let\'s explore different art forms!'
      ]
    };

    // Check for specific subtopics in recent messages
    if (currentTopic === 'math') {
      if (recentMessagesLower.includes('multiply') || recentMessagesLower.includes('times')) {
        return ['Let\'s practice more multiplication!', 'Want to learn multiplication tricks?', 'How about multiplication word problems!'];
      }
      if (recentMessagesLower.includes('add') || recentMessagesLower.includes('plus')) {
        return ['Let\'s try more addition!', 'Want to add bigger numbers?', 'How about addition games!'];
      }
      if (recentMessagesLower.includes('story') && recentMessagesLower.includes('problem')) {
        return ['Let\'s solve another story problem!', 'Want to create our own math story?', 'How about a different type of problem?'];
      }
    }

    if (currentTopic === 'reading') {
      if (recentMessagesLower.includes('story')) {
        return ['Let\'s read another story!', 'Want to create our own story?', 'How about discussing the characters?'];
      }
    }

    if (currentTopic === 'science') {
      if (recentMessagesLower.includes('animal')) {
        return ['Let\'s learn about more animals!', 'Want to explore animal habitats?', 'How about animal behavior?'];
      }
      if (recentMessagesLower.includes('space') || recentMessagesLower.includes('planet')) {
        return ['Let\'s explore more space!', 'Want to learn about different planets?', 'How about space exploration?'];
      }
    }

    return topicSuggestions[currentTopic] || getGeneralSuggestions(session.grade);
  }

  return getGeneralSuggestions(session.grade);
}

// Get general suggestions based on grade level
function getGeneralSuggestions(grade) {
  const gradeLevel = parseInt(grade) || 0;

  if (gradeLevel <= 2) {
    return [
      'Let\'s count together!',
      'Want to learn about colors?',
      'How about animal sounds?'
    ];
  } else if (gradeLevel <= 5) {
    return [
      'Let\'s explore science!',
      'Want to practice math?',
      'How about reading a story?'
    ];
  } else {
    return [
      'Let\'s dive into a subject!',
      'Want to solve a problem?',
      'How about learning something new?'
    ];
  }
}

    function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}


// Get session summary with enhanced details
app.get('/api/session/:sessionId/summary', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    // Add this inside summary route, before building summary:
const topicCounts = {};
session.conversationContext.forEach(c => {
  if (!c.topic) return;
  topicCounts[c.topic] = (topicCounts[c.topic] || 0) + 1;
});
const sortedTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]);
const mostInterested = sortedTopics.length > 0 ? sortedTopics[0][0] : 'various topics';
const totalTopicMentions = sortedTopics.reduce((acc, curr) => acc + curr[1], 0);
let highlights = [];
if (sortedTopics.length > 0) {
  highlights.push(`${session.studentName} showed interest in: ` + sortedTopics
    .map(([topic, count]) => `${capitalize(topic)} (${Math.round((count / totalTopicMentions) * 100)}%)`)
    .join(', ')
  );
} else {
  highlights.push('Showed curiosity and asked thoughtful questions');
}


    const duration = Math.floor((Date.now() - session.startTime.getTime()) / 60000);
    const topics = Array.from(session.topicsDiscussed);

const suggestions = generateRecommendations(session);

const summary = {
  duration: duration > 0 ? `${duration} minutes` : 'Less than a minute',
  totalInteractions: session.totalInteractions,
  totalWarnings: session.totalWarnings || 0,
  topicsExplored: `${session.studentName} showed most interest in: ${mostInterested}`,
  studentName: session.studentName,
  grade: session.grade,
  highlights: highlights,
  suggestions: suggestions,  // <-- use the correct variable
  achievements: session.achievements,
  nextSteps: generateNextSteps(session)
};


    console.log(`📊 Generating summary for session ${sessionId.slice(-6)}. Duration: ${duration} mins, Interactions: ${session.totalInteractions}`);

    res.json(summary);
  } catch (error) {
    console.error(`❌ Error getting summary for session ${req.params.sessionId ? req.params.sessionId.slice(-6) : 'N/A'}:`, error.message);
    res.status(500).json({ error: 'Failed to get session summary. Please try again.' });
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
    console.log(`🛑 Session ${sessionId.slice(-6)} ended manually by user.`);

    res.json({ status: 'ended', message: 'Session successfully closed.' });
  } catch (error) {
    console.error('❌ Error ending session:', error.message);
    res.status(500).json({ error: 'Internal error ending session.' });
  }
});


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

  return steps.slice(0, 3); // Return a maximum of 3 general next steps
}

// Enhanced AI response generation with better engagement
async function generateAIResponse(sessionId, userMessage) { // Removed 'context' parameter
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  // Add user message to session
 session.messages.push({
  role: 'user',
  content: userMessage,
  timestamp: new Date()
});
if (session.messages.length > 100) session.messages = session.messages.slice(-50);


  // Get the dynamic system prompt for the current session state
  const systemPromptContent = getTutorSystemPrompt(session.grade, session.studentName);

  // Filter out previous system messages from history and limit to last 10 relevant messages
  // This ensures the current, dynamic system prompt is always the first sent to OpenAI,
  // followed by a limited history of actual conversation turns.
  const conversationHistoryForAI = session.messages
    .filter(m => m.role !== 'system') // Exclude old system prompts from history
    .slice(-10); // Keep last 10 user/assistant turns

  const messagesToSendToAI = [
    { role: 'system', content: systemPromptContent }, // The current, active system prompt
    ...conversationHistoryForAI.map(msg => ({ // The relevant conversation history
      role: msg.role,
      content: msg.content
    }))
  ];

  try {
    // Adjust max_tokens based on request type
    let maxTokens = 200;
    const lowerMessage = userMessage.toLowerCase();

    if (lowerMessage.includes('story') && (lowerMessage.includes('minute') || lowerMessage.includes('long'))) {
      if (lowerMessage.includes('5 minute') || lowerMessage.includes('five minute')) {
        maxTokens = 800; // Longer story
      } else if (lowerMessage.includes('10 minute') || lowerMessage.includes('ten minute')) {
        maxTokens = 1200; // Very long story
      } else if (lowerMessage.includes('short')) {
        maxTokens = 400; // Short story
      }
    }

    const completion = await openai.chat.completions.create({
      model: config.GPT_MODEL,
      messages: messagesToSendToAI,
      max_tokens: maxTokens,
      temperature: config.GPT_TEMPERATURE,
      presence_penalty: config.GPT_PRESENCE_PENALTY,
      frequency_penalty: config.GPT_FREQUENCY_PENALTY
    });

    const aiResponse = completion.choices[0].message.content;

    // Add AI response to session history
session.messages.push({
  role: 'assistant',
  content: aiResponse,
  timestamp: new Date()
});
if (session.messages.length > 100) session.messages = session.messages.slice(-50); // Only keep last 50


    // Analyze response for additional features
    const subject = classifySubject(userMessage); // Use user message to classify
    const encouragement = generateEncouragement(session);

    return {
      text: aiResponse,
      subject: subject,
      encouragement: encouragement
    };
  } catch (error) {
    console.error(`❌ AI API Error for session ${sessionId.slice(-6)}:`, error.message);

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
      encouragement: generateEncouragement(session)
    };
  }
}

// Enhanced subject classification
function classifySubject(input) {
  const subjects = {
    math: ['math', 'number', 'count', 'add', 'subtract', 'multiply', 'divide', 'calculation', 'algebra', 'geometry', 'fraction', 'decimal', 'percent', 'equation', 'problem', 'plus', 'minus', 'times'],
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

// Generate encouragement based on session progress
function generateEncouragement(session) {
  const encouragements = [
    `You're doing great, ${session.studentName}!`,
    `I love how curious you are!`,
    `Keep up the excellent thinking!`,
    `You're such a good learner!`,
    `I'm proud of how hard you're working!`,
    `Your questions show you're really thinking!`,
    `You're making excellent progress!`,
    `I can see you're really engaged in learning!`
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
    `I can see you're really thinking hard about this! What connections can you make?`,
    `Your curiosity is wonderful! What would you like to discover next?`,
    `That's a thoughtful question! Let's work through it together!`
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// Generate fallback response for general errors
function generateFallbackResponse(message) {
  return "I'm having trouble right now, but I'm still here to help you learn! What would you like to explore together?";
}

// Session management endpoints
app.get('/api/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
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
app.listen(config.PORT, () => {
  console.log(`🎓 Enhanced AI Tutor Backend running on port ${config.PORT}`);
  console.log(`📊 Health check: http://localhost:${config.PORT}/api/health`);
  console.log(`🚀 Ready to help students learn safely!`);
  console.log(`🛡️ Content filtering active for child safety`);
});

module.exports = app;