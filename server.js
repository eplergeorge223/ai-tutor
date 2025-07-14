const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// --- Configuration Constants ---
const config = {
  PORT: process.env.PORT || 3000,
  SESSION_TTL: 45 * 60 * 1000, // 45 minutes of inactivity
  CLEANUP_INTERVAL: 5 * 60 * 1000, // Check for expired sessions every 5 minutes
  GPT_MODEL: 'gpt-4o-mini',
  GPT_TEMPERATURE: 0.7, // Slightly higher for more engaging responses
  GPT_PRESENCE_PENALTY: 0.1, // Encourage more varied responses
  GPT_FREQUENCY_PENALTY: 0.1, // Penalize frequent tokens
  VALID_GRADES: ['PreK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// Sessions will now be stored purely in memory
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

// --- Session Management & Cleanup (In-memory) ---
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.lastActivity > config.SESSION_TTL) {
      console.log(`🧹 Cleaning up expired session ${id.slice(-6)}. Inactivity: ${((now - sess.lastActivity) / 1000 / 60).toFixed(1)} minutes.`);
      sessions.delete(id);
    }
  }
}, config.CLEANUP_INTERVAL);


// --- Helper Functions ---

const getInappropriateResponse = (category, session) => ({
  response: {
    sexual: `That's not something we talk about in our learning time, ${session.studentName}! Let's explore something educational instead. What subject interests you today?`,
    violence: `I'm here to help you learn positive and educational things, ${session.studentName}! What would you like to learn about instead?`,
    profanity: `Let's use kind words in our learning space, ${session.studentName}. What would you like to learn about today?`,
    drugs: `That's not an appropriate topic for our learning time, ${session.studentName}! Let's focus on something educational. What interests you?`,
    inappropriate: `I'm here to help you learn amazing things, ${session.studentName}! What topic would you like to explore today?`
  }[category] || `Let's find something fun to learn instead!`,
  subject: null,
  suggestions: generateSafeSuggestions(session.grade),
  encouragement: `Let's get back to learning, ${session.studentName}!`,
  status: 'redirected'
});

const containsInappropriateContent = (text) => {
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

// Improved system prompt generation - now includes difficulty level
function getTutorSystemPrompt(grade, studentName, difficultyLevel = 0.5) { // difficultyLevel from 0 (easier) to 1 (harder)
  const isEarlyGrade = ['PreK', 'K', '1', '2'].includes(grade);
  const gradeGuidelines = {
    'PreK': 'Use very simple words. 1 sentence max. Focus on basic concepts like colors, shapes, and sounds.',
    'K': 'Simple words, basic ideas. 1–2 sentences. Focus on counting, letters, and simple stories.',
    '1': 'Easy words, encourage trying. 1–2 sentences. Guide them through sounding out words and basic addition.',
    '2': 'Build confidence, simple steps. 2 sentences. Focus on early reading comprehension and two-digit math.',
    '3': 'A bit more detail, still brief. 2–3 sentences. Encourage problem-solving for elementary math and reading analysis.',
    '4': 'Explain clearly, don’t ramble. 2–3 sentences. Help them break down complex ideas in all subjects.',
    '5': 'Good explanations, stay on topic. 3 sentences. Foster independent thinking and deeper understanding.',
    '6': 'A little more complex, still short. 3–4 sentences. Encourage critical thinking for middle school topics.',
    '7': 'Focused and clear. 3–4 sentences. Guide towards analytical skills and deeper inquiry.',
    '8': 'Explain in detail, don’t overwhelm. 3–4 sentences. Help them connect concepts and apply knowledge.',
    '9': 'Cover fully, be efficient. 4–5 sentences. Promote self-directed learning and advanced problem-solving.',
    '10': 'Thorough, but keep it moving. 4–5 sentences. Encourage complex reasoning and independent research.',
    '11': 'Go in-depth, stay focused. 4–5 sentences. Challenge them with nuanced questions and diverse perspectives.',
    '12': 'Complete answers, efficient. 4–5 sentences. Prepare them for higher-level thinking and application.'
  };

  let difficultyAdjustment = '';
  if (difficultyLevel < 0.3) {
    difficultyAdjustment = "The student seems to be struggling. Provide extra clear, simpler steps, more direct hints, and fundamental concepts. Be extra patient and break down tasks into smaller parts.";
  } else if (difficultyLevel > 0.7) {
    difficultyAdjustment = "The student seems to be grasping concepts quickly. Challenge them with more complex questions, encourage deeper inquiry, and introduce related advanced concepts. Keep the pace engaging.";
  } else {
    difficultyAdjustment = "Maintain a steady, encouraging pace. Offer clear guidance and prompt critical thinking.";
  }


  return `
You are an AI Tutor for ${studentName}. Your job: teach students to THINK, not just memorize!
Keep replies short, simple, and step-by-step.
- NEVER give the answer directly. Always guide them with questions, hints, or by showing *how* to approach the problem.
- Always use language a kid that age will understand.
- Use their name in responses sometimes.
- Be patient, encouraging, and celebrate effort.
- If the student gives a wrong or incomplete answer, gently point out the mistake, explain *why* it's not quite right (without giving the correct answer), and encourage them to try again with a guiding question.
- If they answer with something unrelated, or say "I don't know", or ask you to just tell them the answer, gently redirect back to the learning point. Propose 2-3 specific, child-friendly learning options if they are stuck or passive.
- Strictly avoid adult/inappropriate topics: if they come up, say "Let's find something fun to learn instead!" and change the subject.
- Never discuss personal/private matters.

${isEarlyGrade ? `
For reading activities (PreK–2), NEVER say the target word in your message.
Instead, reply in JSON format like this:
{
  "message": "Can you sound out this word, ${studentName}?",
  "READING_WORD": "cat"
}
Pick any age-appropriate word you want for each turn.
` : ''}

Examples:
- Math: "Let's count 5 plus 5 on your fingers. What do you get, ${studentName}?" (Instead of "It's 10.")
- Reading: "Sound out c-a-t. What word is that?" (Instead of "The word is cat.")
- Science: "What do you think happens to ice in the sun?" (Instead of "It melts.")

Stay positive, focused, and always teach the process!
${gradeGuidelines[grade] || gradeGuidelines['K']}
${difficultyAdjustment}
`.trim();
}

const createSessionObject = (sessionId, studentName, grade, subjects) => ({
  id: sessionId,
  studentName: studentName || 'Student',
  grade: grade || 'K',
  subjects: subjects || [],
  startTime: Date.now(), // Store as timestamp
  lastActivity: Date.now(),
  messages: [{ role: 'system', content: getTutorSystemPrompt(grade, studentName), timestamp: Date.now() }],
  totalWarnings: 0,
  topicsDiscussed: new Set(), // Stored as a Set
  currentTopic: null,
  topicBreakdown: {},
  conversationContext: [],
  achievements: [],
  strugglingAreas: [],
  preferredLearningStyle: null,
  difficultyLevel: 0.5 // Start at neutral difficulty
});

const generateSessionId = () => Date.now().toString(36) + Math.random().toString(36).substr(2);

// More engaging welcome message
const generateWelcomeMessage = (studentName, grade) => {
  const common = `Hi ${studentName}! I'm your tutor today. What are you curious about?`;
  const gradeSpecific = {
    'PreK': `Hi ${studentName}! Let's learn together! What sounds fun to explore today, like colors or animal sounds?`,
    'K': `Hello ${studentName}! What sounds fun today? We could count, learn letters, or talk about animals!`,
    '1': `Hi ${studentName}! Ready to learn cool things? Do you want to practice reading, try some math, or discover science?`,
    '2': `Hey ${studentName}! What should we explore? Maybe a tricky math problem, an interesting story, or a science question?`,
    '3': `Hi ${studentName}! What are you curious about today? We can dive into anything—math, reading, science, or even history!`
  };
  return gradeSpecific[grade] || common;
};

const generateSafeSuggestions = (grade) => {
  const general = ['Let\'s explore science!', 'Want to learn about animals?', 'How about some fun math?', 'Let\'s read a story together!', 'What about learning something new?'];
  const gradeSpecific = {
    'PreK': ['Let\'s learn colors!', 'What about shapes?', 'Let\'s sing a song!'],
    'K': ['Let\'s count!', 'What about letters?', 'Let\'s learn animal sounds!'],
    '1': ['Let\'s practice ABCs!', 'How about counting to 100?', 'Tell me about your favorite animal!']
  };
  return (gradeSpecific[grade] || general).sort(() => 0.5 - Math.random()).slice(0, 3);
};

// Enhanced dynamic suggestions with concept introduction
const generateDynamicSuggestions = (session) => {
  const ctx = (session.conversationContext || []).slice(-5);
  const recentUser = ctx.filter(e => e.role === 'user');
  const lastUser = recentUser[recentUser.length - 1] || {};
  const { topic, subtopic } = lastUser;
  const struggling = recentUser.length >= 2 &&
    recentUser[recentUser.length - 1].topic === recentUser[recentUser.length - 2].topic &&
    recentUser[recentUser.length - 1].subtopic === recentUser[recentUser.length - 2].subtopic;
  const masterySignals = session.achievements.filter(a => a.topic === topic && a.subtopic === subtopic).length > 0;

  const suggestionsMap = {
    math: {
      addition: {
        struggling: ["Want to review some addition tips together?", "Need help with addition? Try using your fingers or objects around you!", "Let’s slow down and try a different example."],
        mastered: ["Ready to try a harder addition problem?", "Want to switch to subtraction for a bit?", "How about exploring *multiplication*, which builds on addition?", "Curious how addition works with bigger numbers?"],
        default: ["Want a quick addition game?", "Let's practice addition with some real-world examples!", "What's another addition problem you'd like to try?"]
      },
      multiplication: {
        struggling: ["Let's review the multiplication tables.", "How about drawing arrays to understand multiplication?", "We can use repeated addition to solve this."],
        mastered: ["Ready for some division challenges?", "How about *fractions* next, they involve multiplication!", "Let's explore word problems with multiplication!"],
        default: ["Want a quick times table game?", "Ready for a real-world multiplication problem?", "Try a quick multiplication quiz?"]
      },
      default: ["Want a math puzzle?", "Switch to a different math topic?", "Try a quick math quiz?", "Explore how math is used in daily life!"]
    },
    reading: {
      vocabulary: {
        struggling: ["Let's try finding the definition of that word again.", "Can you think of a synonym for that word?", "Let's read a simpler sentence with that word."],
        mastered: ["Want to learn new words from a specific story?", "Try using those words in your own sentences?", "How about exploring *grammar* next, using those new words?", "Let's try a vocabulary quiz!"],
        default: ["Want to learn new words?", "Try using those words in a sentence?", "Want to read a short story?"]
      },
      comprehension: {
        struggling: ["Let's re-read that part slowly. What do you notice?", "Can you tell me in your own words what happened here?", "Let's break down the main idea into smaller pieces."],
        mastered: ["Ready to read a longer story and discuss it?", "How about we explore different types of stories, like *fables* or *myths*?", "Let's practice summarizing a more complex paragraph!"],
        default: ["Want to read together?", "Need help with tricky words?", "Switch to a fun story?"]
      },
      default: ["Want to read together?", "Need help with tricky words?", "Switch to a fun story?", "Explore different kinds of books!"]
    },
    science: {
      animals: {
        struggling: ["Let's look at some pictures of different animal groups.", "What's one thing you know about this animal?", "We can compare two animals to see their differences."],
        mastered: ["Want to learn about a different animal or animal group?", "Curious about animal habitats or how they *adapt* to their environment?", "How about exploring animal life cycles?", "Let's learn about *ecosystems* next!"],
        default: ["Want to learn about a different animal?", "Curious about animal habitats?", "How about animal adaptations?"]
      },
      space: {
        struggling: ["Let's look at a picture of our solar system again.", "Can you name one planet you know?", "What's one question you have about space?"],
        mastered: ["Want to learn about stars and galaxies?", "How about astronauts and rockets, and how they travel in space?", "Let's explore *gravity* next, how does it affect space?", "What about exploring the concept of time in space?"],
        default: ["Want to learn about planets?", "How about stars and galaxies?", "What about astronauts and rockets?"]
      },
      default: ["Try a science experiment at home?", "Explore another science topic?", "Ask a big science question!", "How about exploring the human body?"]
    }
    // Add more subjects and their specific subtopic suggestions for struggling/mastered
  };

  let suggestions = [];
  if (topic && subtopic && suggestionsMap[topic] && suggestionsMap[topic][subtopic]) {
    if (struggling) {
      suggestions = suggestionsMap[topic][subtopic].struggling || suggestionsMap[topic][subtopic].default;
      // Mark as struggling in session if not already
      if (!session.strugglingAreas.includes(`${topic} - ${subtopic}`)) {
        session.strugglingAreas.push(`${topic} - ${subtopic}`);
      }
    } else if (masterySignals) {
      suggestions = suggestionsMap[topic][subtopic].mastered || suggestionsMap[topic][subtopic].default;
      // Remove from struggling if they master it
      session.strugglingAreas = session.strugglingAreas.filter(s => s !== `${topic} - ${subtopic}`);
    } else {
      suggestions = suggestionsMap[topic][subtopic].default;
    }
  } else if (topic && suggestionsMap[topic] && suggestionsMap[topic].default) {
    suggestions = suggestionsMap[topic].default;
  } else {
    suggestions = generateSafeSuggestions(session.grade); // General fallback
  }

  // Ensure unique suggestions and always offer to change topic if stuck
  return Array.from(new Set([...suggestions.slice(0, 2), "Want to pick a new topic?", "What else are you curious about?"])).slice(0, 3);
};


const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);

function buildPersonalizedSummary(session) {
  const lines = [];
  for (const [subject, breakdown] of Object.entries(session.topicBreakdown)) {
    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const [topSub, topCount] = Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0] || [];
    if (topSub) {
      lines.push(`${session.studentName} focused mostly on **${capitalize(topSub)}** in **${capitalize(subject)}** (${Math.round((topCount / total) * 100)}% of their questions in this area).`);
    } else {
      lines.push(`${session.studentName} showed an interest in **${capitalize(subject)}**.`);
    }
  }
  return lines.length ? lines.join(' ') : `Showed curiosity and asked thoughtful questions.`;
}

function generateRecommendations(session) {
  const { topicBreakdown: breakdown = {} } = session;
  const recs = [];

  const getTopSubtopic = (subject) => {
    if (!breakdown[subject]) return null;
    const subs = Object.entries(breakdown[subject]);
    return subs.length ? subs.sort((a, b) => b[1] - a[1])[0][0] : null;
  };

  const addRec = (subject, defaultMsg) => {
    const top = getTopSubtopic(subject);
    if (top) {
      recs.push(`Keep practicing **${capitalize(top)}** in ${capitalize(subject)}—you're making awesome progress!`);
    } else if (breakdown[subject]) {
      recs.push(defaultMsg);
    }
  };

  addRec('math', 'Practice math problems regularly to build confidence.');
  addRec('reading', 'Keep reading different types of books to expand vocabulary.');
  addRec('science', 'Try simple science experiments at home.');
  addRec('music', 'Discover different types of music and instruments!');
  addRec('pe', 'Remember to keep moving and play your favorite sports!');
  addRec('technology', 'Explore more about how technology works around you!');
  addRec('language', 'Try learning new words in a different language!');

  if (session.strugglingAreas && session.strugglingAreas.length > 0) {
    recs.push(`Consider spending more time on: ${session.strugglingAreas.map(s => `**${s}**`).join(', ')}.`);
  }
  if (session.achievements && session.achievements.length > 0) {
    recs.push(`Great job mastering: ${session.achievements.map(a => `**${a.subtopic} in ${a.topic}**`).join(', ')}!`);
  }

  return recs.length ? recs : [`Continue exploring topics that spark your curiosity, ${session.studentName}!`];
}

function generateNextSteps(session) {
  if (session.strugglingAreas && session.strugglingAreas.length > 0) {
    const lastStruggle = session.strugglingAreas[session.strugglingAreas.length - 1];
    return [`You could use some extra practice on **${lastStruggle}**. Let's focus more on this next time.`];
  }

  const { topicBreakdown: breakdown = {} } = session;
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
    return [`Great job with **${capitalize(bestSub)}** in **${capitalize(bestSubject)}**! Try more exercises to master it.`];
  }
  return ['Keep exploring and practicing what interests you most!'];
}

async function generateAIResponse(sessionId, userMessage) {
  const session = sessions.get(sessionId); // Get directly from in-memory Map
  if (!session) throw new Error('Session not found');

  session.messages.push({ role: 'user', content: userMessage, timestamp: Date.now() });
  // Keep only last 6 messages (including system prompt) for brevity and cost
  session.messages = session.messages.slice(-6);

  // Prepare messages for AI (system + last 4 user/assistant exchanges)
  const messagesToSendToAI = [
    { role: 'system', content: getTutorSystemPrompt(session.grade, session.studentName, session.difficultyLevel) }, // Pass difficulty
    ...session.messages.filter(m => m.role !== 'system').slice(-4).map(msg => ({ role: msg.role, content: msg.content }))
  ];

  try {
    let maxTokens = getMaxTokensForGrade(session.grade);
    if (userMessage.toLowerCase().includes('story')) {
      maxTokens = Math.min(maxTokens * 2, 300);
    }
    // Adjust temperature based on difficulty: lower for struggling, higher for mastering
    const adjustedTemperature = session.difficultyLevel < 0.3 ? 0.5 : (session.difficultyLevel > 0.7 ? 0.8 : config.GPT_TEMPERATURE);

    const completion = await openai.chat.completions.create({
      model: config.GPT_MODEL,
      messages: messagesToSendToAI,
      max_tokens: maxTokens,
      temperature: adjustedTemperature, // Use adjusted temperature
      presence_penalty: config.GPT_PRESENCE_PENALTY,
      frequency_penalty: config.GPT_FREQUENCY_PENALTY,
      stop: ["\n\n", "Additionally,", "Furthermore,", "Moreover,"] // CRITICAL FIX: MAX LENGTH 4
    });

    let aiText = completion.choices[0].message.content.trim();

    // Check for "I don't know" or similar from user to trigger specific helpful suggestions
    const lowerUserMessage = userMessage.toLowerCase();
    if (["i don't know", "i dunno", "tell me", "what is the answer", "what are you talking about", "break what down"].some(phrase => lowerUserMessage.includes(phrase))) {
        // AI should have been prompted to give specific options, if not, layer them on here
        const options = generateSafeSuggestions(session.grade).map(s => s.toLowerCase());
        // Only add if AI didn't already explicitly suggest options
        if (!options.some(opt => aiText.toLowerCase().includes(opt)) && !aiText.includes("math") && !aiText.includes("reading") && !aiText.includes("science")) {
             aiText += `\n\nNo worries, ${session.studentName}! How about we pick from **math**, **reading**, or **science**?`;
        }
    }


    session.messages.push({ role: 'assistant', content: aiText, timestamp: Date.now() });

    const { subject, subtopic } = classifySubject(userMessage);
    const encouragement = generateEncouragement(session);

    // Update difficulty level based on response (placeholder logic)
    // A more advanced system would analyze user engagement, correctness of subsequent answers, etc.
    // For now, let's assume if the user keeps asking for help or "I don't know", difficulty decreases.
    // If user is moving forward, difficulty increases.
    const lastUserMessageContent = session.messages.filter(m => m.role === 'user').slice(-1)[0]?.content.toLowerCase();
    if (["i don't know", "i dunno", "tell me", "what is the answer", "break what down", "what are you talking about"].some(phrase => lastUserMessageContent.includes(phrase))) {
        session.difficultyLevel = Math.max(0.1, session.difficultyLevel - 0.1); // Decrease difficulty
    } else if (aiText.length > 50 && !aiText.includes("wrong") && !aiText.includes("mistake")) { // Heuristic for progress
        session.difficultyLevel = Math.min(0.9, session.difficultyLevel + 0.05); // Increase difficulty slightly
    }


    // No saveSession() call here as we are now purely in-memory

    return { text: aiText, subject, subtopic, encouragement };
  } catch (error) {
    console.error(`❌ AI API Error for session ${sessionId.slice(-6)}:`, error.message);
    const fallbackResponse = generateContextualFallback(userMessage, session);

    session.messages.push({ role: 'assistant', content: fallbackResponse, timestamp: Date.now() });
    // No saveSession() call here

    return {
      text: fallbackResponse,
      subject: classifySubject(userMessage).subject,
      encouragement: generateEncouragement(session)
    };
  }
}

const getMaxTokensForGrade = (grade) => {
  const gradeLevel = parseInt(grade) || 0;
  if (gradeLevel <= 2) return 50;
  if (gradeLevel <= 5) return 75;
  if (gradeLevel <= 8) return 100;
  return 125;
};

// Adjusted contextual fallback to be more guiding immediately
const generateContextualFallback = (input, session) => {
  // If the user has just been passive or asking for answers, offer clear choices
  const passivePhrases = ["i don't know", "i dunno", "tell me", "what is the answer", "break what down", "what are you talking about"];
  if (passivePhrases.some(phrase => input.toLowerCase().includes(phrase))) {
      return `No worries, ${session.studentName}! Sometimes it helps to pick. Would you like to explore **math**, **reading**, or **science** right now?`;
  }

  const fallbacks = [
    `That's a really interesting thought, ${session.studentName}! How do you think we could explore that question together?`,
    `I love how you're thinking! To help us learn, what specific part of this topic are you most curious about?`,
    `You're asking such good questions! Let's break it down. What's the first thing we should consider?`
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
};

// UNIVERSAL K-12 SUBJECTS & SUBTOPICS CLASSIFIER (same as before, but included for completeness)
const subjects = {
  math: {
    keywords: ['math', 'number', 'add', 'subtract', 'plus', 'minus', 'multiply', 'times', 'divide', 'calculation', 'fraction', 'decimal', 'percent', 'equation', 'algebra', 'geometry', 'graph', 'problem', 'count', 'multiplication', 'division', 'sum', 'difference', 'product', 'quotient'],
    subtopics: {
      counting: ['count', 'number', 'numbers', 'how many'],
      addition: ['add', 'addition', 'plus', 'sum'],
      subtraction: ['subtract', 'subtraction', 'minus', 'difference'],
      multiplication: ['multiply', 'multiplication', 'times', 'product'],
      division: ['divide', 'division', 'divided', 'quotient'],
      fractions: ['fraction', 'fractions'],
      decimals: ['decimal', 'decimals'],
      percentages: ['percent', 'percentage'],
      algebra: ['algebra', 'equation', 'variable', 'expression', 'solve x'],
      geometry: ['geometry', 'shape', 'angle', 'area', 'perimeter', 'circle', 'triangle', 'square', 'volume'],
      graphing: ['graph', 'chart', 'plot', 'data'],
      wordProblems: ['story problem', 'word problem']
    }
  },
  reading: {
    keywords: ['read', 'reading', 'book', 'story', 'chapter', 'comprehension', 'vocabulary', 'sentence', 'phonics', 'letter', 'word', 'paragraph', 'main idea', 'summarize', 'author', 'character', 'literacy', 'fiction', 'non-fiction'],
    subtopics: {
      phonics: ['phonics', 'letter sound', 'sound it out', 'blends'],
      vocabulary: ['vocabulary', 'word', 'definition', 'meaning'],
      comprehension: ['comprehension', 'understand', 'main idea', 'summary', 'summarize', 'plot', 'theme'],
      stories: ['story', 'chapter', 'book', 'author', 'fiction', 'non-fiction'],
      characters: ['character', 'who', 'what about'],
      fluency: ['fluency', 'read aloud', 'speed'],
      writing: ['write', 'writing', 'sentence', 'paragraph', 'essay', 'compose', 'grammar']
    }
  },
  science: {
    keywords: ['science', 'experiment', 'nature', 'animal', 'plant', 'biology', 'earth', 'space', 'physics', 'chemistry', 'weather', 'ecosystem', 'habitat', 'energy', 'force', 'motion', 'life cycle', 'observe', 'hypothesis', 'scientific'],
    subtopics: {
      animals: ['animal', 'mammal', 'reptile', 'amphibian', 'insect', 'bird', 'fish', 'habitat', 'zoology'],
      plants: ['plant', 'tree', 'flower', 'seed', 'photosynthesis', 'botany'],
      space: ['space', 'planet', 'star', 'moon', 'solar system', 'galaxy', 'astronomy'],
      weather: ['weather', 'rain', 'cloud', 'storm', 'temperature', 'climate'],
      earthScience: ['earth', 'rock', 'soil', 'volcano', 'ocean', 'mountain', 'landform', 'geology'],
      physics: ['force', 'motion', 'gravity', 'energy', 'push', 'pull', 'magnet', 'light', 'sound'],
      chemistry: ['chemistry', 'atom', 'molecule', 'element', 'mixture', 'solution', 'reaction'],
      lifeCycles: ['life cycle', 'grow', 'change', 'metamorphosis', 'reproduction'],
      scientificMethod: ['experiment', 'observe', 'hypothesis', 'investigate', 'data']
    }
  },
  socialStudies: {
    keywords: ['history', 'government', 'president', 'country', 'community', 'citizen', 'geography', 'culture', 'economy', 'vote', 'map', 'war', 'historical', 'civics', 'world', 'continent', 'nation'],
    subtopics: {
      history: ['history', 'past', 'historical', 'war', 'revolution', 'event', 'timeline', 'ancient'],
      geography: ['map', 'globe', 'continent', 'country', 'state', 'city', 'river', 'mountain', 'landforms', 'regions'],
      government: ['government', 'president', 'democracy', 'vote', 'law', 'politics', 'senate', 'house'],
      culture: ['culture', 'tradition', 'custom', 'society', 'beliefs'],
      economy: ['economy', 'money', 'trade', 'supply', 'demand', 'goods', 'services'],
      civics: ['citizen', 'community', 'rights', 'responsibilities', 'rules', 'laws']
    }
  },
  music: {
    keywords: ['music', 'song', 'sing', 'instrument', 'note', 'melody', 'rhythm', 'band', 'choir', 'composer', 'sound'],
    subtopics: {
      singing: ['sing', 'singing', 'choir', 'voice'],
      instruments: ['instrument', 'piano', 'guitar', 'drum', 'violin', 'flute', 'trumpet'],
      rhythm: ['rhythm', 'beat', 'tempo'],
      melody: ['melody', 'tune', 'pitch'],
      musicTheory: ['note', 'scale', 'key', 'chord'],
      composers: ['composer', 'musician', 'band', 'artist', 'orchestra']
    }
  },
  pe: {
    keywords: ['pe', 'gym', 'exercise', 'physical', 'activity', 'sports', 'run', 'jump', 'game', 'fitness', 'health', 'move', 'body'],
    subtopics: {
      fitness: ['fitness', 'exercise', 'workout', 'strength', 'endurance'],
      sports: ['sports', 'basketball', 'soccer', 'baseball', 'football', 'volleyball', 'swimming', 'tennis'],
      games: ['game', 'tag', 'relay', 'teamwork'],
      health: ['health', 'nutrition', 'food', 'wellness', 'hygiene'],
      movement: ['run', 'jump', 'skip', 'throw', 'catch', 'balance']
    }
  },
  technology: {
    keywords: ['computer', 'technology', 'robot', 'coding', 'program', 'type', 'internet', 'website', 'device', 'app', 'digital', 'screen', 'software', 'hardware'],
    subtopics: {
      coding: ['code', 'coding', 'programming', 'scratch', 'python', 'javascript', 'algorithm'],
      robotics: ['robot', 'robotics', 'automation'],
      typing: ['type', 'typing', 'keyboard'],
      internetSafety: ['internet', 'safety', 'cyber', 'online', 'website', 'privacy'],
      devices: ['device', 'tablet', 'laptop', 'desktop', 'app', 'phone', 'smartwatch']
    }
  },
  language: {
    keywords: ['language', 'spanish', 'french', 'german', 'english', 'word', 'phrase', 'translate', 'conversation', 'speak', 'foreign language'],
    subtopics: {
      vocabulary: ['word', 'vocabulary', 'definition', 'phrase'],
      grammar: ['grammar', 'sentence', 'verb', 'noun', 'adjective', 'pronoun', 'syntax'],
      conversation: ['speak', 'talk', 'conversation', 'dialogue'],
      translation: ['translate', 'translation'],
      culture: ['culture', 'country', 'customs', 'traditions']
    }
  },
};

// Classifier function (kept the same)
const classifySubject = (input) => {
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
};

const generateEncouragement = (session) => {
  const encouragements = [
    `You're doing great, ${session.studentName}!`,
    `I love how curious you are!`,
    `Keep up the excellent thinking!`,
    `You're such a good learner!`,
    `I'm proud of how hard you're working!`,
    `Your questions show you're really thinking!`,
    `You're making excellent progress!`,
    `I can see you're really engaged in learning!`,
    `That's a super question, ${session.studentName}!`,
    `Fantastic effort!`,
    `You're really getting the hang of this!`,
    `Brilliant thinking!`
  ];
  return encouragements[Math.floor(Math.random() * encouragements.length)];
};

// --- API Endpoints ---

// Start new tutoring session
app.post('/api/session/start', async (req, res) => {
  try {
    const { studentName, grade, subjects: studentSubjects } = req.body;

    if (typeof studentName !== 'string' || typeof grade !== 'string' || (studentSubjects && !Array.isArray(studentSubjects))) {
      return res.status(400).json({ error: 'Invalid session parameters.' });
    }

    const validatedGrade = config.VALID_GRADES.includes(grade) ? grade : 'K';
    const validatedName = studentName && studentName.trim() ? studentName.trim() : 'Student';

    const sessionId = generateSessionId();
    const session = createSessionObject(sessionId, validatedName, validatedGrade, studentSubjects);
    sessions.set(sessionId, session); // Store in-memory

    console.log(`🚀 Session started: ID ending in ${sessionId.slice(-6)}, Student: ${validatedName}, Grade: ${validatedGrade}`);

    res.json({
      sessionId,
      welcomeMessage: generateWelcomeMessage(validatedName, validatedGrade),
      status: 'success',
      sessionInfo: {
        studentName: validatedName,
        grade: validatedGrade,
        startTime: new Date(session.startTime).toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Error starting session:', error.message);
    res.status(500).json({ error: 'Failed to start session. Please try again.' });
  }
});

// Enhanced chat endpoint with content filtering
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message } = req.body;

    const session = sessions.get(sessionId); // Get directly from in-memory Map
    if (!session) {
      return res.status(400).json({ error: 'Invalid or expired session. Please start a new session.' });
    }
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    session.lastActivity = Date.now();

    // Check for inappropriate content in user's message
    const contentCheckUser = containsInappropriateContent(message);
    if (contentCheckUser.inappropriate) {
      session.totalWarnings = (session.totalWarnings || 0) + 1;
      console.warn(`🚨 SECURITY ALERT: Inappropriate content detected in session ${sessionId.slice(-6)}: "${contentCheckUser.word}" (Category: ${contentCheckUser.category}).`);
      return res.json(getInappropriateResponse(contentCheckUser.category, session));
    }

    console.log(`💬 Chat message for session ${sessionId.slice(-6)} from ${session.studentName} (Grade: ${session.grade}). Message: "${message.substring(0, Math.min(message.length, 50))}..."`);

    // Generate AI response
    const aiResponse = await generateAIResponse(sessionId, message.trim());

    // Check for inappropriate content in AI's response (safety check)
    const contentCheckAI = containsInappropriateContent(aiResponse.text);
    if (contentCheckAI.inappropriate) {
      session.totalWarnings = (session.totalWarnings || 0) + 1;
      console.warn(`🚨 LLM OUTPUT ALERT: Inappropriate content in response for session ${sessionId.slice(-6)}: "${contentCheckAI.word}" (Category: ${contentCheckAI.category}).`);
      return res.json(getInappropriateResponse(contentCheckAI.category, session));
    }

    // Track topics and learning patterns based on the *user's* input
    const { subject, subtopic } = classifySubject(message);
    if (subject) {
      session.topicsDiscussed.add(subject);
      session.currentTopic = subject; // Update current topic in session
      session.topicBreakdown[subject] = session.topicBreakdown[subject] || {};
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
    session.conversationContext = session.conversationContext.slice(-5); // Keep only last 5 context items

    let messageText = aiResponse.text;
    let readingWord = null;

    // Try to parse JSON for reading prompt (PreK-2)
    try {
      const maybeJson = JSON.parse(messageText);
      if (maybeJson && maybeJson.READING_WORD) {
        messageText = maybeJson.message;
        readingWord = maybeJson.READING_WORD;
      }
    } catch (e) { /* Not JSON; keep as regular text */ }

    res.json({
      response: messageText,
      readingWord: readingWord,
      subject: subject,
      suggestions: generateDynamicSuggestions(session),
      encouragement: generateEncouragement(session),
      status: 'success',
      sessionStats: {
        totalWarnings: session.totalWarnings || 0,
        topicsDiscussed: Array.from(session.topicsDiscussed)
      }
    });

  } catch (error) {
    console.error(`❌ Error processing chat for session: ${req.body.sessionId ? req.body.sessionId.slice(-6) : 'N/A'}:`, error.message);
    // Attempt to get session for contextual fallback even in error state
    const sessionForFallback = sessions.get(req.body.sessionId);

    res.status(500).json({
      error: 'Failed to process message due to an internal error. Please try again.',
      fallback: generateContextualFallback(req.body.message || '', sessionForFallback || { studentName: 'learner' }) // Provide a default student name if session is entirely lost
    });
  }
});

// Get session summary with enhanced details
app.get('/api/session/:sessionId/summary', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId); // Get directly from in-memory Map

    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    const topicCounts = {};
    session.conversationContext.forEach(c => {
      if (!c.topic) return;
      topicCounts[c.topic] = (topicCounts[c.topic] || 0) + 1;
    });
    const sortedTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]);
    const totalTopicMentions = sortedTopics.reduce((acc, curr) => acc + curr[1], 0);

    const highlights = sortedTopics.length > 0
      ? `**${session.studentName}** showed interest in: ` + sortedTopics
          .map(([topic, count]) => `**${capitalize(topic)}** (${Math.round((count / totalTopicMentions) * 100)}%)`)
          .join(', ')
      : 'Showed curiosity and asked thoughtful questions.';

    const duration = Math.floor((Date.now() - session.startTime) / 60000); // Use timestamp directly

    const summary = {
      duration: duration > 0 ? `${duration} minutes` : 'Less than a minute',
      totalWarnings: session.totalWarnings || 0,
      topicsExplored: buildPersonalizedSummary(session),
      studentName: session.studentName,
      grade: session.grade,
      highlights: highlights,
      recommendations: generateRecommendations(session),
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
    if (!sessions.delete(sessionId)) { // Delete from in-memory Map
      return res.status(404).json({ error: 'Session not found or already ended.' });
    }
    console.log(`🛑 Session ${sessionId.slice(-6)} ended manually by user.`);
    res.json({ status: 'ended', message: 'Session successfully closed.' });
  } catch (error) {
    console.error('❌ Error ending session:', error.message);
    res.status(500).json({ error: 'Internal error ending session.' });
  }
});

// Session management endpoints (status)
app.get('/api/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId); // Get directly from in-memory Map

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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    activeSessionsInCache: sessions.size, // Updated to reflect in-memory sessions
    uptime: process.uptime()
  });
});

// Start server and keep reference for shutdown
const server = app.listen(config.PORT, () => {
  console.log(`🎓 Enhanced AI Tutor Backend running on port ${config.PORT}`);
  console.log(`📊 Health check: http://localhost:${config.PORT}/api/health`);
  console.log(`🚀 Ready to help students learn safely!`);
  console.log(`🛡️ Content filtering active for child safety`);
  console.log(`⚠️ Sessions are in-memory and will be lost if the server restarts or expires.`); // Explicit warning
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