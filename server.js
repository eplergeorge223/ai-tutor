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
  GPT_TEMPERATURE: 0.7, // Slightly higher for more engaging responses
  GPT_PRESENCE_PENALTY: 0.1, // Encourage more varied responses
  GPT_FREQUENCY_PENALTY: 0.1, // Penalize frequent tokens
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

const regex = new RegExp(`\\b${word}\\b`, 'i');
if (regex.test(lowerText)) {
  // False positive exceptions (tweak as needed)
  const exceptions = ['class', 'assistant', 'pass', 'assignment'];
  for (const exc of exceptions) {
    if (lowerText.includes(exc)) return { inappropriate: false };
  }
  return { inappropriate: true, category, word };
}


// Generate session ID
function getTutorSystemPrompt(grade, studentName) {
  const basePrompt = `
You are an AI Tutor for ${studentName}. Your job: teach students to THINK, not just memorize! 
Keep replies short, simple, and step-by-step. 
- Never just give answers; show how to solve and ask guiding questions.
- Always use language a kid that age will understand.
- Use their name in responses sometimes.
- Be patient, encouraging, and celebrate effort.
- Strictly avoid adult/inappropriate topics: if they come up, say "Let's find something fun to learn instead!" and change the subject.
- Never discuss personal/private matters.

Response limits:
- PreK–2: 1–2 sentences.
- 3–5: 2–3 sentences.
- 6–8: 3–4 sentences.
- 9–12: 4–5 sentences.

Examples:
- Math: "Let's count 5 plus 5 on your fingers. What do you get, ${studentName}?"
- Reading: "Sound out c-a-t. What word is that?"
- Science: "What do you think happens to ice in the sun?"

Stay positive, focused, and always teach the process!
  `.trim();

  const gradeGuidelines = {
    'PreK': 'Use very simple words. 1 sentence max.',
    'K': 'Simple words, basic ideas. 1–2 sentences.',
    '1': 'Easy words, encourage trying. 1–2 sentences.',
    '2': 'Build confidence, simple steps. 2 sentences.',
    '3': 'A bit more detail, still brief. 2–3 sentences.',
    '4': 'Explain clearly, don’t ramble. 2–3 sentences.',
    '5': 'Good explanations, stay on topic. 3 sentences.',
    '6': 'A little more complex, still short. 3–4 sentences.',
    '7': 'Focused and clear. 3–4 sentences.',
    '8': 'Explain in detail, don’t overwhelm. 3–4 sentences.',
    '9': 'Cover fully, be efficient. 4–5 sentences.',
    '10': 'Thorough, but keep it moving. 4–5 sentences.',
    '11': 'Go in-depth, stay focused. 4–5 sentences.',
    '12': 'Complete answers, efficient. 4–5 sentences.'
  };

  return `${basePrompt}\n\n${gradeGuidelines[grade] || gradeGuidelines['K']}`;
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
        totalWarnings: 0,
        topicsDiscussed: new Set(),
        currentTopic: null,
        topicBreakdown: {}, 
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

    const aiContentCheck = containsInappropriateContent(response.text);
if (aiContentCheck.inappropriate) {
  session.totalWarnings = (session.totalWarnings || 0) + 1;
  const redirectResponse = generateRedirectResponse(aiContentCheck.category, session);
  console.warn(`🚨 LLM OUTPUT ALERT: Inappropriate content in response for session ${sessionId.slice(-6)}: "${aiContentCheck.word}" (Category: ${aiContentCheck.category}).`);
  return res.json({
    response: redirectResponse,
    subject: null,
    suggestions: generateSafeSuggestions(session.grade),
    encouragement: generateEncouragement(session),
    status: 'redirected'
  });
}

    // Track topics and learning patterns
const { subject, subtopic } = classifySubject(message);
if (subject) {
  session.topicsDiscussed.add(subject);
  session.currentTopic = subject;
  if (!session.topicBreakdown[subject]) session.topicBreakdown[subject] = {};
  if (subtopic) {
    session.topicBreakdown[subject][subtopic] = (session.topicBreakdown[subject][subtopic] || 0) + 1;
  }
}


    // Update conversation context for better suggestions
 session.conversationContext.push({
  role: 'user',
  message: message,
  topic: subject,
  subtopic: subtopic,
  timestamp: Date.now()
});

    // Keep only last 5 context items
    if (session.conversationContext.length > 5) {
      session.conversationContext = session.conversationContext.slice(-5);
    }

    res.json({
      response: response.text,
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

function generateDynamicSuggestions(session) {
    // Get the last 3 user messages with topic/subtopic context
    const ctx = (session.conversationContext || []).slice(-5); // recent context
    const recentUser = ctx.filter(e => e.role === 'user');
    const lastUser = recentUser[recentUser.length - 1] || {};
    const topic = lastUser.topic || session.currentTopic || null;
    const subtopic = lastUser.subtopic || null;

    // Super basic "struggling" detection: 2+ repeated questions or same topic
    const struggling = recentUser.length >= 2 &&
        recentUser[recentUser.length-1].topic === recentUser[recentUser.length-2].topic &&
        recentUser[recentUser.length-1].subtopic === recentUser[recentUser.length-2].subtopic;

    // Examples for core subjects
    if (topic === 'math') {
        if (subtopic === 'addition') {
            if (struggling) return [
                "Want to review some addition tips together?",
                "Need help with addition? Try using your fingers or objects around you!",
                "Let’s slow down and try a different example."
            ];
            return [
                "Ready to try a harder addition problem?",
                "Want to switch to subtraction for a bit?",
                "Curious how addition works with bigger numbers?"
            ];
        }
        if (subtopic === 'multiplication') {
            return [
                "Want a quick times table game?",
                "Ready for a real-world multiplication problem?",
                "Switch to division for a challenge?"
            ];
        }
        // ... more subtopics
        return [
            "Want a math puzzle?",
            "Switch to a different math topic?",
            "Try a quick math quiz?"
        ];
    }
    if (topic === 'reading') {
        if (subtopic === 'vocabulary') {
            return [
                "Want to learn new words?",
                "Try using those words in a sentence?",
                "Want to read a short story?"
            ];
        }
        return [
            "Want to read together?",
            "Need help with tricky words?",
            "Switch to a fun story?"
        ];
    }
    if (topic === 'science') {
        if (subtopic === 'animals') {
            return [
                "Want to learn about a different animal?",
                "Curious about animal habitats?",
                "How about animal adaptations?"
            ];
        }
        if (subtopic === 'space') {
            return [
                "Want to learn about planets?",
                "How about stars and galaxies?",
                "What about astronauts and rockets?"
            ];
        }
        return [
            "Try a science experiment at home?",
            "Explore another science topic?",
            "Ask a big science question!"
        ];
    }
    // Fallback/general
    return [
        "Pick a new topic to explore!",
        "Ask me anything!",
        "Want a fun learning game?"
    ];
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


function buildPersonalizedSummary(session) {
  const lines = [];
  for (const [subject, breakdown] of Object.entries(session.topicBreakdown)) {
    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const [topSub, topCount] = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0] || [];
    if (topSub) {
      lines.push(
        `${session.studentName} focused mostly on ${capitalize(topSub)} in ${capitalize(subject)} (${Math.round((topCount / total) * 100)}% of their questions in this area).`
      );
    } else {
      lines.push(`${session.studentName} showed an interest in ${capitalize(subject)}.`);
    }
  }
  if (!lines.length) {
    lines.push(`Showed curiosity and asked thoughtful questions.`);
  }
  return lines.join(' ');
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
  totalWarnings: session.totalWarnings || 0,
topicsExplored: buildPersonalizedSummary(session),
  studentName: session.studentName,
  grade: session.grade,
  highlights: highlights,
  suggestions: suggestions, 
  nextSteps: generateNextSteps(session)
};


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
    const breakdown = session.topicBreakdown || {};
    const recs = [];

    // Helper to get most discussed subtopic for a subject
    function getTopSubtopic(subject) {
        if (!breakdown[subject]) return null;
        const subs = Object.entries(breakdown[subject]);
        if (!subs.length) return null;
        subs.sort((a, b) => b[1] - a[1]);
        return subs[0][0]; // return subtopic string
    }

    // Math
    if (breakdown.math) {
        const top = getTopSubtopic('math');
        if (top) {
            recs.push(`Keep practicing ${top} problems—you're making awesome progress!`);
        } else {
            recs.push('Practice math problems regularly to build confidence.');
        }
    }
    // Reading
    if (breakdown.reading) {
        const top = getTopSubtopic('reading');
        if (top) {
            recs.push(`Explore more stories about ${top}—you seem to love that!`);
        } else {
            recs.push('Keep reading different types of books to expand vocabulary.');
        }
    }
    // Science
    if (breakdown.science) {
        const top = getTopSubtopic('science');
        if (top) {
            recs.push(`Dive deeper into ${top}—you asked lots of great questions!`);
        } else {
            recs.push('Try simple science experiments at home.');
        }
    }
    // Add more subjects here if you want, following the same pattern

    // General fallback if no main subject
    if (recs.length === 0) {
        return `Continue exploring topics that spark your curiosity, ${session.studentName}!`;
    }
    return recs;
}

// Generate next steps for continued learning
function generateNextSteps(session) {
    // If there’s a specific struggle, address it
    if (session.strugglingAreas && session.strugglingAreas.length > 0) {
        // Use only the most recent or most frequent
        const lastStruggle = session.strugglingAreas[session.strugglingAreas.length - 1];
        return [`You could use some extra practice on ${lastStruggle}. Let's focus more on this next time.`];
    }

    // Otherwise, use main subtopic (most discussed)
    const breakdown = session.topicBreakdown || {};
    let bestSubject = null, bestSub = null, bestCount = 0;

    for (const [subject, subs] of Object.entries(breakdown)) {
        for (const [sub, count] of Object.entries(subs)) {
            if (count > bestCount) {
                bestSubject = subject;
                bestSub = sub;
                bestCount = count;
            }
        }
    }
    if (bestSubject && bestSub) {
        return [`Great job with ${bestSub} in ${bestSubject}! Try more exercises to master it.`];
    }

    // General fallback
    return ['Keep exploring and practicing what interests you most!'];
}

async function generateAIResponse(sessionId, userMessage) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Session not found');

  session.messages.push({
    role: 'user',
    content: userMessage,
    timestamp: new Date()
  });

  // Keep only last 6 messages to reduce context and cost
  if (session.messages.length > 6) {
    session.messages = session.messages.slice(-6);
  }

  const systemPromptContent = getTutorSystemPrompt(session.grade, session.studentName);
  
  const conversationHistoryForAI = session.messages
    .filter(m => m.role !== 'system')
    .slice(-4); // Only last 4 exchanges

  const messagesToSendToAI = [
    { role: 'system', content: systemPromptContent },
    ...conversationHistoryForAI.map(msg => ({
      role: msg.role,
      content: msg.content
    }))
  ];

  try {
    // Much more aggressive token limits
    let maxTokens = getMaxTokensForGrade(session.grade);
    
    // Only allow longer responses for explicit story requests
    const lowerMessage = userMessage.toLowerCase();
    if (lowerMessage.includes('tell me a story') || lowerMessage.includes('story about')) {
      maxTokens = Math.min(maxTokens * 2, 300); // Cap even stories
    }
const completion = await openai.chat.completions.create({
  model: config.GPT_MODEL,
  messages: messagesToSendToAI,
  max_tokens: maxTokens,
  temperature: config.GPT_TEMPERATURE,
  presence_penalty: config.GPT_PRESENCE_PENALTY,
  frequency_penalty: config.GPT_FREQUENCY_PENALTY,
  stop: ["\n\n", "Additionally,", "Furthermore,", "Moreover,"]
});

const aiResponse = completion.choices[0].message.content.trim();
const sentenceLimits = { PreK: 1, K: 2, '1': 2, '2': 2, '3': 3, '4': 3, '5': 3, '6': 4, '7': 4, '8': 4, '9': 5, '10': 5, '11': 5, '12': 5 };
const maxSentences = sentenceLimits[session.grade] || 2;
const sentences = aiResponse.match(/[^.!?]+[.!?]+/g) || [aiResponse];
const trimmedResponse = sentences.slice(0, maxSentences).join(' ').trim();

// Output filtering
const aiContentCheck = containsInappropriateContent(trimmedResponse);
let finalResponse = trimmedResponse;
if (aiContentCheck.inappropriate) {
  session.totalWarnings = (session.totalWarnings || 0) + 1;
  finalResponse = generateRedirectResponse(aiContentCheck.category, session);
  console.warn(`🚨 LLM OUTPUT ALERT: Inappropriate content in response for session ${sessionId.slice(-6)}: "${aiContentCheck.word}" (Category: ${aiContentCheck.category}).`);
}

session.messages.push({
  role: 'assistant',
  content: finalResponse,
  timestamp: new Date()
});

    const subject = classifySubject(userMessage);
    const encouragement = generateEncouragement(session);

    return {
      text: aiResponse,
      subject: subject,
      encouragement: encouragement
    };

  } catch (error) {
    console.error(`❌ AI API Error for session ${sessionId.slice(-6)}:`, error.message);
    
    const fallbackResponse = generateShortFallback(userMessage, session);
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


function getMaxTokensForGrade(grade) {
  const gradeLevel = parseInt(grade) || 0;
  
  if (gradeLevel <= 2) return 50;   // PreK-2: Very short
  if (gradeLevel <= 5) return 75;   // 3-5: Short
  if (gradeLevel <= 8) return 100;  // 6-8: Medium
  return 125; // 9-12: Longer but still reasonable
}

function generateShortFallback(input, session) {
  const shortFallbacks = [
    `That's interesting, ${session.studentName}! Tell me more!`,
    `Great question! What do you think?`,
    `I love how you think! What else?`,
    `You're so curious! What's next?`,
    `Good thinking! Let's explore more!`
  ];
  return shortFallbacks[Math.floor(Math.random() * shortFallbacks.length)];
}


// UNIVERSAL K-12 SUBJECTS & SUBTOPICS CLASSIFIER

const subjects = {
  math: {
    keywords: ['math', 'number', 'add', 'subtract', 'plus', 'minus', 'multiply', 'times', 'divide', 'calculation', 'fraction', 'decimal', 'percent', 'equation', 'algebra', 'geometry', 'graph', 'problem', 'count', 'multiplication', 'division'],
    subtopics: {
      counting: ['count', 'number', 'numbers', 'how many'],
      addition: ['add', 'addition', 'plus'],
      subtraction: ['subtract', 'subtraction', 'minus'],
      multiplication: ['multiply', 'multiplication', 'times'],
      division: ['divide', 'division', 'divided'],
      fractions: ['fraction', 'fractions'],
      decimals: ['decimal', 'decimals'],
      percentages: ['percent', 'percentage'],
      algebra: ['algebra', 'equation', 'variable', 'expression'],
      geometry: ['geometry', 'shape', 'angle', 'area', 'perimeter', 'circle', 'triangle', 'square'],
      graphing: ['graph', 'chart', 'plot'],
      wordProblems: ['story problem', 'word problem'],
    }
  },
  reading: {
    keywords: ['read', 'reading', 'book', 'story', 'chapter', 'comprehension', 'vocabulary', 'sentence', 'phonics', 'letter', 'word', 'paragraph', 'main idea', 'summarize', 'author', 'character'],
    subtopics: {
      phonics: ['phonics', 'letter sound', 'sound it out'],
      vocabulary: ['vocabulary', 'word', 'definition'],
      comprehension: ['comprehension', 'understand', 'main idea', 'summary', 'summarize'],
      stories: ['story', 'chapter', 'book', 'author'],
      characters: ['character', 'who'],
      fluency: ['fluency', 'read aloud', 'speed'],
      writing: ['write', 'writing', 'sentence', 'paragraph', 'essay'],
    }
  },
  science: {
    keywords: ['science', 'experiment', 'nature', 'animal', 'plant', 'biology', 'earth', 'space', 'physics', 'chemistry', 'weather', 'ecosystem', 'habitat', 'energy', 'force', 'motion', 'life cycle', 'observe'],
    subtopics: {
      animals: ['animal', 'mammal', 'reptile', 'amphibian', 'insect', 'bird', 'fish', 'habitat'],
      plants: ['plant', 'tree', 'flower', 'seed', 'photosynthesis'],
      space: ['space', 'planet', 'star', 'moon', 'solar system'],
      weather: ['weather', 'rain', 'cloud', 'storm', 'temperature'],
      earthScience: ['earth', 'rock', 'soil', 'volcano', 'ocean', 'mountain', 'landform'],
      physics: ['force', 'motion', 'gravity', 'energy', 'push', 'pull'],
      chemistry: ['chemistry', 'atom', 'molecule', 'element', 'mixture', 'solution'],
      lifeCycles: ['life cycle', 'grow', 'change', 'metamorphosis'],
      scientificMethod: ['experiment', 'observe', 'hypothesis', 'investigate'],
    }
  },
  socialStudies: {
    keywords: ['history', 'government', 'president', 'country', 'community', 'citizen', 'geography', 'culture', 'economy', 'vote', 'map', 'war', 'historical'],
    subtopics: {
      history: ['history', 'past', 'historical', 'war', 'revolution', 'event'],
      geography: ['map', 'globe', 'continent', 'country', 'state', 'city', 'river', 'mountain'],
      government: ['government', 'president', 'law', 'vote', 'election'],
      citizenship: ['citizen', 'citizenship', 'rights', 'responsibility'],
      culture: ['culture', 'custom', 'tradition'],
      economics: ['economy', 'money', 'trade', 'goods', 'services', 'market'],
    }
  },
  art: {
    keywords: ['art', 'draw', 'paint', 'sculpt', 'color', 'shape', 'design', 'picture', 'creative', 'artist'],
    subtopics: {
      drawing: ['draw', 'sketch'],
      painting: ['paint', 'painting'],
      sculpture: ['sculpt', 'sculpture', 'clay'],
      colorTheory: ['color', 'primary color', 'mix'],
      design: ['design', 'create', 'creative'],
      artists: ['artist', 'famous artist', 'art history'],
    }
  },
  music: {
    keywords: ['music', 'song', 'sing', 'instrument', 'note', 'melody', 'rhythm', 'band', 'choir'],
    subtopics: {
      singing: ['sing', 'singing', 'choir', 'voice'],
      instruments: ['instrument', 'piano', 'guitar', 'drum', 'violin'],
      rhythm: ['rhythm', 'beat'],
      melody: ['melody', 'tune'],
      musicTheory: ['note', 'scale', 'key'],
      composers: ['composer', 'musician', 'band', 'artist'],
    }
  },
  pe: {
    keywords: ['pe', 'gym', 'exercise', 'physical', 'activity', 'sports', 'run', 'jump', 'game', 'fitness', 'health'],
    subtopics: {
      fitness: ['fitness', 'exercise', 'workout'],
      sports: ['sports', 'basketball', 'soccer', 'baseball', 'football', 'volleyball'],
      games: ['game', 'tag', 'relay'],
      health: ['health', 'nutrition', 'food'],
      movement: ['run', 'jump', 'skip', 'throw', 'catch'],
    }
  },
  technology: {
    keywords: ['computer', 'technology', 'robot', 'coding', 'program', 'type', 'internet', 'website', 'device', 'app'],
    subtopics: {
      coding: ['code', 'coding', 'programming', 'scratch', 'python', 'javascript'],
      robotics: ['robot', 'robotics'],
      typing: ['type', 'typing'],
      internetSafety: ['internet', 'safety', 'cyber', 'online', 'website'],
      devices: ['device', 'tablet', 'laptop', 'desktop', 'app'],
    }
  },
  language: {
    keywords: ['language', 'spanish', 'french', 'german', 'english', 'word', 'phrase', 'translate', 'conversation'],
    subtopics: {
      vocabulary: ['word', 'vocabulary', 'definition'],
      grammar: ['grammar', 'sentence', 'verb', 'noun', 'adjective'],
      conversation: ['speak', 'talk', 'conversation'],
      translation: ['translate', 'translation'],
      culture: ['culture', 'country'],
    }
  },
  // Add any more (life skills, SEL, etc) as needed
};

// Classifier function
function classifySubject(input) {
  if (!input) return { subject: null, subtopic: null };
  const lowerInput = input.toLowerCase();

  for (const [subject, data] of Object.entries(subjects)) {
    // Use RegExp for word boundaries for higher precision
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
      return { subject, subtopic: bestSub }; // Return null if no subtopic matched
    }
  }
  return { subject: null, subtopic: null };
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

// Start server and keep reference for shutdown
const server = app.listen(config.PORT, () => {
  console.log(`🎓 Enhanced AI Tutor Backend running on port ${config.PORT}`);
  console.log(`📊 Health check: https://ai-tutor-ww9f.onrender.com/api/health`);
  console.log(`🚀 Ready to help students learn safely!`);
  console.log(`🛡️ Content filtering active for child safety`);
});

// Graceful shutdown (SIGTERM and Ctrl+C)
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