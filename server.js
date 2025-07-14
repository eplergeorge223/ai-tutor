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
    sexual: ['sex', 'sexual', 'porn', 'vagina', 'penis', 'breasts', 'naked', 'intercourse', 'masturbate', 'orgasm', 'condom', 'pregnancy'],
    violence: ['kill', 'murder', 'bomb', 'gun', 'knife', 'suicide', 'violence', 'abuse', 'hurt', 'pain', 'blood', 'weapon'],
    profanity: ['fuck', 'shit', 'asshole', 'bitch', 'cunt', 'damn', 'hell', 'crap', 'piss', 'dick', 'cock'],
    drugs: ['drugs', 'drug', 'marijuana', 'weed', 'cocaine', 'heroin', 'alcohol', 'beer', 'wine', 'smoking', 'high', 'drunk'],
    hateSpeech: ['racist', 'n-word', 'faggot', 'retard', 'idiot', 'stupid', 'loser', 'ugly', 'fat', 'dumb', 'hate'],
    inappropriateGeneral: ['gang', 'crime', 'cult', 'gossip', 'rumor', 'cheating', 'fraud']
  }
};

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ FATAL: Missing OPENAI_API_KEY environment variable. Please set it in your .env file.');
  process.exit(1);
}

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sessions = new Map(); // Sessions stored purely in memory

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

const getInappropriateResponse = (category, session) => {
    const baseMessage = {
        sexual: `That's not something we talk about in our learning time, ${session.studentName}! Let's explore something educational instead. What subject interests you today?`,
        violence: `I'm here to help you learn positive and educational things, ${session.studentName}! What would you like to learn about instead?`,
        profanity: `Let's use kind words in our learning space, ${session.studentName}. What would you like to learn about today?`,
        drugs: `That's not an appropriate topic for our learning time, ${session.studentName}! Let's focus on something educational. What interests you?`,
        hateSpeech: `Let's make sure our learning space is respectful and kind, ${session.studentName}. What topic would you like to explore today?`,
        inappropriateGeneral: `I'm here to help you learn amazing things, ${session.studentName}! What educational topic would you like to explore today?`
    }[category] || `Let's find something fun to learn instead!`;

    return {
        response: baseMessage,
        subject: null,
        suggestions: generateSafeSuggestions(session.grade, true), // Force general suggestions here
        encouragement: `Let's get back to learning, ${session.studentName}!`,
        status: 'redirected'
    };
};

const containsInappropriateContent = (text) => {
  const lowerText = text.toLowerCase();
  for (const [category, words] of Object.entries(config.INAPPROPRIATE_TOPICS)) {
    for (const word of words) {
      if (new RegExp(`\\b${word}\\b`, 'i').test(lowerText) || lowerText.includes(` ${word} `)) {
        return { inappropriate: true, category, word };
      }
    }
  }
  return { inappropriate: false };
};

// --- ENHANCED SYSTEM PROMPT ---
function getTutorSystemPrompt(grade, studentName, difficultyLevel = 0.5, needsFoundationalReview = null) {
  const isEarlyGrade = ['PreK', 'K', '1', '2'].includes(grade);
  const gradeGuidelines = {
    'PreK': 'Use very simple words. 1-2 sentences max. Focus on basic concepts like colors, shapes, and sounds. Be extra gentle and nurturing.',
    'K': 'Simple words, basic ideas. 1-2 sentences. Focus on counting, letters, and simple stories. Encourage exploration.',
    '1': 'Easy words, encourage trying. 1-2 sentences. Guide them through sounding out words and basic addition. Celebrate small wins.',
    '2': 'Build confidence, simple steps. 2-3 sentences. Focus on early reading comprehension and two-digit math. Prompt for their ideas.',
    '3': 'A bit more detail, still brief. 2-3 sentences. Encourage problem-solving for elementary math and reading analysis. Use relatable examples.',
    '4': 'Explain clearly, don’t ramble. 2-3 sentences. Help them break down complex ideas in all subjects. Ask "why" and "how".',
    '5': 'Good explanations, stay on topic. 3 sentences. Foster independent thinking and deeper understanding. Encourage them to explain their reasoning.',
    '6': 'A little more complex, still short. 3-4 sentences. Encourage critical thinking for middle school topics. Connect concepts to real-world scenarios.',
    '7': 'Focused and clear. 3-4 sentences. Guide towards analytical skills and deeper inquiry. Promote researching ideas.',
    '8': 'Explain in detail, don’t overwhelm. 3-4 sentences. Help them connect concepts and apply knowledge. Challenge them to think creatively.',
    '9': 'Cover fully, be efficient. 4-5 sentences. Promote self-directed learning and advanced problem-solving. Encourage debate and diverse perspectives.',
    '10': 'Thorough, but keep it moving. 4-5 sentences. Encourage complex reasoning and independent research. Guide them to form their own conclusions.',
    '11': 'Go in-depth, stay focused. 4-5 sentences. Challenge them with nuanced questions and diverse perspectives. Facilitate critical evaluation.',
    '12': 'Complete answers, efficient. 4-5 sentences. Prepare them for higher-level thinking and application. Encourage deep dives and interdisciplinary connections.'
  };

  let difficultyAdjustment = '';
  if (difficultyLevel < 0.3) {
    difficultyAdjustment = "The student seems to be struggling. Provide extra clear, simpler steps, more direct hints, and fundamental concepts. Be extra patient and break down tasks into smaller parts. Ensure responses are very encouraging and reframe mistakes as learning opportunities.";
  } else if (difficultyLevel > 0.7) {
    difficultyAdjustment = "The student seems to be grasping concepts quickly. Challenge them with more complex questions, encourage deeper inquiry, and introduce related advanced concepts. Keep the pace engaging and encourage independent exploration.";
  } else {
    difficultyAdjustment = "Maintain a steady, encouraging pace. Offer clear guidance and prompt critical thinking. Balance challenge with support.";
  }

  let foundationalReviewInstruction = '';
  if (needsFoundationalReview && needsFoundationalReview.skill === 'counting') {
    foundationalReviewInstruction = `
    The student is currently struggling with basic counting, which is essential for the current math problem.
    **CRITICAL TASK**: Temporarily pause the original problem. Your sole focus is now to gently teach and reinforce basic counting from 1 to 10 or 1 to 20 (depending on grade).
    Guide them through counting step-by-step, patiently. For example, ask them to count to 5, then to 10.
    Once they demonstrate they can count accurately, you will smoothly transition back to the original problem: "${needsFoundationalReview.originalProblem}". Acknowledge their counting success and then re-introduce the original question.
    Do NOT return to the original problem until they show competence in counting.
    `;
  }

  return `
You are an AI Tutor named Byte. Your job: teach students to THINK, not just memorize!
Keep replies short, simple, and step-by-step.
- NEVER give the answer directly. Always guide them with questions, hints, or by showing *how* to approach the problem.
- Always use language a kid that age will understand.
- Use their name in responses sometimes, like "Great thinking, ${studentName}!"
- Be patient, encouraging, and celebrate effort. Use a warm, empathetic, and vibrant tone.
- If the student gives a wrong or incomplete answer, gently point out the mistake, explain *why* it's not quite right (without giving the correct answer), and encourage them to try again with a guiding question. Frame it as a step in learning.
- **CRITICAL**: If the student says "I don't know" or asks you to just tell them the answer, *stay on the current topic or gently guide them to pick one*.
    - If there's an active learning topic, rephrase the question, offer a different hint, or break the *current problem* into smaller, more manageable steps. **DO NOT abruptly change the subject.**
    - If no specific topic has been established yet (e.g., in an initial "I don't know" scenario), offer 2-3 diverse and appealing educational options. Phrase them as exciting opportunities, e.g., "We could dive into the mysteries of space, explore fun math puzzles, or read an exciting story. Which one sparks your curiosity?"
    - If the student says "you pick one" or similar, acknowledge it and then propose 1-2 engaging options and ask for their preference. E.g., "Okay, I can pick a fun one for us! How about we start with a little math puzzle? Or maybe an exciting science fact? Which sounds more interesting to you, ${studentName}?"
- **FOUNDATIONAL SKILL MANAGEMENT**: If a student reveals a misunderstanding of a *foundational skill* required for the current problem (e.g., struggling with counting for an addition problem), gently pivot the lesson to focus on that foundational skill until competency is shown, then gracefully return to the original problem. This is critical for building true understanding.
- **NEVER** ask the student to perform physical actions that the AI cannot see or verify (e.g., "show me fingers", "point to"). Instead, use imagination or conceptual examples (e.g., "Imagine you have 5 apples...", "Think about what happens when you combine...").
- Only activate the "inappropriate topic" response if the topic is genuinely non-educational, harmful, or explicitly listed in the restricted words. If a topic like 'music' is brought up, engage with it educationally unless specific inappropriate keywords are used.
- Strictly avoid adult/inappropriate topics: if they come up, say "That's not something we talk about in our learning time, ${studentName}! Let's explore something educational instead. What subject interests you today?" and immediately change the subject to general educational options.
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
- Math: "Imagine you have 5 red blocks and 5 blue blocks. If you put them all together, how many blocks do you have in total, ${studentName}?" (Instead of "It's 10.")
- Reading: "Sound out c-a-t. What word is that?" (Instead of "The word is cat.")
- Science: "What do you think happens to ice in the sun?" (Instead of "It melts.")

Stay positive, focused, and always teach the process!
${gradeGuidelines[grade] || gradeGuidelines['K']}
${difficultyAdjustment}
${foundationalReviewInstruction}
`.trim();
}

const createSessionObject = (sessionId, studentName, grade, subjects) => ({
  id: sessionId,
  studentName: studentName || 'Student',
  grade: grade || 'K',
  subjects: subjects || [],
  startTime: Date.now(),
  lastActivity: Date.now(),
  messages: [{ role: 'system', content: getTutorSystemPrompt(grade, studentName), timestamp: Date.now() }],
  totalWarnings: 0,
  topicsDiscussed: new Set(),
  currentTopic: null,
  currentSubtopic: null, // Track current subtopic more explicitly
  topicBreakdown: {},
  conversationContext: [],
  achievements: [],
  strugglingAreas: [],
  preferredLearningStyle: null,
  difficultyLevel: 0.5,
  needsFoundationalReview: null // { skill: 'counting', originalProblem: '7 apples and 3 more' }
});

const generateSessionId = () => Date.now().toString(36) + Math.random().toString(36).substr(2);

const generateWelcomeMessage = (studentName, grade) => {
  const common = `Hi ${studentName}! I'm your tutor today. What are you curious about?`;
  const gradeSpecific = {
    'PreK': `Hi ${studentName}! I'm Byte, your tutor! Let's learn together! What sounds fun to explore today, like colors or animal sounds?`,
    'K': `Hello ${studentName}! I'm Byte! What sounds fun today? We could count, learn letters, or talk about animals!`,
    '1': `Hi ${studentName}! I'm Byte! Ready to learn cool things? Do you want to practice reading, try some math, or discover science?`,
    '2': `Hey ${studentName}! I'm Byte! What should we explore? Maybe a tricky math problem, an interesting story, or a science question?`,
    '3': `Hi ${studentName}! I'm Byte! What are you curious about today? We can dive into anything—math, reading, science, or even history!`
  };
  return gradeSpecific[grade] || common;
};

// --- ENHANCED SUGGESTIONS ---
const generateSafeSuggestions = (grade, forceGeneral = false) => {
  const generalSuggestions = [
    'Let\'s explore the wonders of science!',
    'Want to learn about fascinating animals?',
    'How about some fun math puzzles?',
    'Let\'s read an exciting story together!',
    'What about discovering new music rhythms?',
    'Curious about how technology works?',
    'How about a peek into history?'
  ].sort(() => 0.5 - Math.random()); // Shuffle for variety

  if (forceGeneral) {
    return generalSuggestions.slice(0, 3);
  }

  const gradeSpecific = {
    'PreK': ['Let\'s learn colors!', 'What about shapes?', 'Let\'s sing a song!'],
    'K': ['Let\'s count!', 'What about letters?', 'Let\'s learn animal sounds!'],
    '1': ['Let\'s practice ABCs!', 'How about counting to 100?', 'Tell me about your favorite animal!']
  };

  const currentSuggestions = (gradeSpecific[grade] || generalSuggestions).sort(() => 0.5 - Math.random());
  
  // Ensure a mix, and always allow picking new topic
  const finalSuggestions = Array.from(new Set([
    ...currentSuggestions.slice(0, 2),
    'Want to pick a new topic?',
    'What else are you curious about?'
  ]));

  return finalSuggestions.slice(0, 3); // Keep it concise
};

// --- ENHANCED DYNAMIC SUGGESTIONS ---
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
        struggling: ["Let's review some addition tips together, ${studentName}!", "Need help with addition? Try using objects or drawing!", "Let’s slow down and try a different example of addition."],
        mastered: ["Ready to try a harder addition problem, ${studentName}?", "Want to switch to subtraction for a bit?", "How about exploring multiplication, which builds on addition?", "Curious how addition works with bigger numbers?"],
        default: ["Want a quick addition game?", "Let's practice addition with some real-world examples!", "What's another addition problem you'd like to try?"]
      },
      multiplication: {
        struggling: ["Let's review the multiplication tables.", "How about drawing arrays to understand multiplication?", "We can use repeated addition to solve this."],
        mastered: ["Ready for some division challenges?", "How about fractions next, they involve multiplication!", "Let's explore word problems with multiplication!"],
        default: ["Want a quick times table game?", "Ready for a real-world multiplication problem?", "Try a quick multiplication quiz?"]
      },
      default: ["Want a math puzzle?", "Switch to a different math topic?", "Try a quick math quiz?", "Explore how math is used in daily life!"]
    },
    reading: {
      vocabulary: {
        struggling: ["Let's try finding the definition of that word again.", "Can you think of a synonym for that word?", "Let's read a simpler sentence with that word."],
        mastered: ["Want to learn new words from a specific story?", "Try using those words in your own sentences?", "How about exploring grammar next, using those new words?", "Let's try a vocabulary quiz!"],
        default: ["Want to learn new words?", "Try using those words in a sentence?", "Want to read a short story?"]
      },
      comprehension: {
        struggling: ["Let's re-read that part slowly. What do you notice?", "Can you tell me in your own words what happened here?", "Let's break down the main idea into smaller pieces."],
        mastered: ["Ready to read a longer story and discuss it?", "How about we explore different types of stories, like fables or myths?", "Let's practice summarizing a more complex paragraph!"],
        default: ["Want to read together?", "Need help with tricky words?", "Switch to a fun story?"]
      },
      default: ["Want to read together?", "Need help with tricky words?", "Switch to a fun story?", "Explore different kinds of books!"]
    },
    science: {
      animals: {
        struggling: ["Let's look at some pictures of different animal groups.", "What's one thing you know about this animal?", "We can compare two animals to see their differences."],
        mastered: ["Want to learn about a different animal or animal group?", "Curious about animal habitats or how they adapt to their environment?", "How about exploring animal life cycles?", "Let's learn about ecosystems next!"],
        default: ["Want to learn about a different animal?", "Curious about animal habitats?", "How about animal adaptations?"]
      },
      space: {
        struggling: ["Let's look at a picture of our solar system again.", "Can you name one planet you know?", "What's one question you have about space?"],
        mastered: ["Want to learn about stars and galaxies?", "How about astronauts and rockets, and how they travel in space?", "Let's explore gravity next, how does it affect space?", "What about exploring the concept of time in space?"],
        default: ["Want to learn about planets?", "How about stars and galaxies?", "What about astronauts and rockets?"]
      },
      default: ["Try a science experiment at home?", "Explore another science topic?", "Ask a big science question!", "How about exploring the human body!"]
    },
    music: {
      instruments: {
        struggling: ["Let's listen to sounds from different instruments again.", "Can you name one instrument you know?", "What's one question you have about instruments?"],
        mastered: ["Want to learn about different types of music?", "How about exploring the history of music?", "Let's try composing a simple rhythm!", "Curious about how instruments make sound?"],
        default: ["Want to learn about different instruments?", "How about music from around the world?", "What about composing a simple song?"]
      },
      rhythm: {
        struggling: ["Let's clap out a simple rhythm together.", "Can you feel the beat in this song?", "How about we try a different rhythm pattern?"],
        mastered: ["Ready to try a more complex rhythm?", "How about exploring melody next, and how it works with rhythm?", "Let's try writing your own rhythm pattern!"],
        default: ["Want to learn about different rhythms?", "How about listening for rhythm in songs?", "What about creating your own rhythm?"]
      },
      default: ["Want to learn about different types of music?", "How about music history?", "What about composing a simple melody?", "Let's discover how sound works!"]
    },
    socialStudies: {
      history: {
        struggling: ["Let's review the timeline of this historical event.", "Can you tell me one fact about this time period?", "How about we focus on one key figure or moment?"],
        mastered: ["Ready to explore a different era in history?", "How about we discuss the impact of this event on the world?", "Let's dive into primary sources from this time!"],
        default: ["Want to learn about famous historical events?", "How about exploring different cultures through history?", "What about significant historical figures?"]
      },
      geography: {
        struggling: ["Let's look at a map of this region again.", "Can you name one famous landmark here?", "How about we learn about the climate of this place?"],
        mastered: ["Ready to explore a new continent or country?", "How about learning about different types of landforms?", "Let's try drawing a map of your neighborhood!"],
        default: ["Want to learn about different countries and capitals?", "How about exploring the world's oceans?", "What about famous mountains?"]
      },
      default: ["Want to learn about world cultures?", "How about famous leaders?", "What about different forms of government?"]
    },
    pe: {
      fitness: {
        struggling: ["Let's try a simpler exercise to warm up.", "What's one way you like to stay active?", "How about we learn about the benefits of a healthy snack?"],
        mastered: ["Ready to try a new sport?", "How about learning about advanced fitness techniques?", "Let's explore the science behind how our bodies move!"],
        default: ["Want to learn about different sports?", "How about healthy eating tips?", "What about fun ways to exercise?"]
      },
      sports: {
        struggling: ["Let's review the rules of this game.", "Can you tell me one skill used in this sport?", "How about we watch a video clip to understand it better?"],
        mastered: ["Ready to learn about a new sport?", "How about strategies for playing this game better?", "Let's explore the history of sports!"],
        default: ["Want to learn about different sports?", "How about famous athletes?", "What about the rules of your favorite game?"]
      },
      default: ["Want to learn about staying active?", "How about healthy habits?", "What about different ways to play and move?"]
    },
    technology: {
      coding: {
        struggling: ["Let's break down this code into smaller steps.", "What's the first thing you think this code does?", "How about we try a simpler coding puzzle?"],
        mastered: ["Ready to try a more complex coding challenge?", "How about creating your own simple program?", "Let's explore different coding languages!"],
        default: ["Want to learn about how computers think?", "How about creating your own small game?", "What about solving a coding puzzle?"]
      },
      robotics: {
        struggling: ["Let's look at the different parts of a robot.", "What's one thing you think robots can do?", "How about we imagine a robot and what it could help us with?"],
        mastered: ["Ready to design your own robot?", "How about learning about advanced robotics?", "Let's explore how robots are used in the real world!"],
        default: ["Want to learn about different types of robots?", "How about how robots move?", "What about building simple robots?"]
      },
      default: ["Want to learn about how technology helps us?", "How about exploring the internet?", "What about designing a new app idea?"]
    },
    language: {
      vocabulary: {
        struggling: ["Let's review the new words and their meanings.", "Can you think of a sentence using this word?", "How about we practice saying the word aloud?"],
        mastered: ["Ready to learn more words in this language?", "How about using these words in a conversation?", "Let's explore phrases and idioms!"],
        default: ["Want to learn new words in a different language?", "How about practicing common phrases?", "What about learning simple greetings?"]
      },
      grammar: {
        struggling: ["Let's look at how sentences are built in this language.", "Can you identify the subject or verb in this sentence?", "How about we simplify the sentence structure?"],
        mastered: ["Ready to explore more complex grammar rules?", "How about practicing writing sentences in this language?", "Let's learn about different tenses!"],
        default: ["Want to learn how to build sentences?", "How about understanding verbs and nouns?", "What about common grammar rules?"]
      },
      default: ["Want to learn about a new language?", "How about exploring common phrases?", "What about understanding different alphabets?"]
    }
  };

  let suggestions = [];
  // Prioritize current topic/subtopic suggestions
  if (topic && subtopic && suggestionsMap[topic] && suggestionsMap[topic][subtopic]) {
    if (struggling) {
      suggestions = suggestionsMap[topic][subtopic].struggling || suggestionsMap[topic][subtopic].default;
      if (!session.strugglingAreas.includes(`${topic} - ${subtopic}`)) {
        session.strugglingAreas.push(`${topic} - ${subtopic}`);
      }
    } else if (masterySignals) {
      suggestions = suggestionsMap[topic][subtopic].mastered || suggestionsMap[topic][subtopic].default;
      session.strugglingAreas = session.strugglingAreas.filter(s => s !== `${topic} - ${subtopic}`);
    } else {
      suggestions = suggestionsMap[topic][subtopic].default;
    }
  } else if (topic && suggestionsMap[topic] && suggestionsMap[topic].default) {
    // If only topic, but no specific subtopic progress, use general topic suggestions
    suggestions = suggestionsMap[topic].default;
  } else {
    // If no topic detected or conversation is very early, use safe general suggestions
    suggestions = generateSafeSuggestions(session.grade, true);
  }

  // Ensure unique and relevant suggestions, always include an option to change topics
  return Array.from(new Set([...suggestions.slice(0, 2), "Want to pick a new topic?", "What else are you curious about?", "Let's try a different challenge!"]))
             .slice(0, 3) // Keep it to 3 concise options
             .map(s => s.replace('${studentName}', session.studentName)); // Personalize
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
  return lines.length ? lines.join(' ') : `Showed curiosity and asked thoughtful questions throughout the session.`;
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
      recs.push(`Keep practicing **${capitalize(top)}** in **${capitalize(subject)}**—you're making awesome progress!`);
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
  addRec('socialStudies', 'Dive deeper into fascinating historical events or world cultures!');


  if (session.strugglingAreas && session.strugglingAreas.length > 0) {
    recs.push(`Consider spending more time on: **${session.strugglingAreas.map(s => `${s}`).join(', ')}** to build even stronger understanding.`);
  }
  if (session.achievements && session.achievements.length > 0) {
    recs.push(`Great job mastering: **${session.achievements.map(a => `${a.subtopic} in ${a.topic}`).join(', ')}**! Keep building on these successes!`);
  }

  return recs.length ? recs : [`Continue exploring topics that spark your curiosity, ${session.studentName}! There's so much to learn!`];
}

function generateNextSteps(session) {
  if (session.strugglingAreas && session.strugglingAreas.length > 0) {
    const lastStruggle = session.strugglingAreas[session.strugglingAreas.length - 1];
    return [`You could use some extra practice on **${lastStruggle}**. Let's focus more on this next time to turn challenges into triumphs!`];
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
    return [`Great job with **${capitalize(bestSub)}** in **${capitalize(bestSubject)}**! Try more exercises to master it completely and become a real expert!`];
  }
  return ['Keep exploring and practicing what interests you most! Every question makes you smarter!'];
}

// Dummy function for topic classification - you'd likely expand this
function classifySubject(text) {
    const lowerText = text.toLowerCase();
    if (lowerText.includes('math') || lowerText.includes('add') || lowerText.includes('subtract') || lowerText.includes('number') || lowerText.includes('count')) {
        let subtopic = null;
        if (lowerText.includes('add') || lowerText.includes('plus')) subtopic = 'addition';
        if (lowerText.includes('subtract') || lowerText.includes('minus')) subtopic = 'subtraction';
        if (lowerText.includes('multiply') || lowerText.includes('times')) subtopic = 'multiplication';
        if (lowerText.includes('divide')) subtopic = 'division';
        if (lowerText.includes('count')) subtopic = 'counting';
        return { subject: 'math', subtopic: subtopic || 'general' };
    }
    if (lowerText.includes('read') || lowerText.includes('story') || lowerText.includes('book') || lowerText.includes('word') || lowerText.includes('letter')) {
        let subtopic = null;
        if (lowerText.includes('word') || lowerText.includes('vocabulary')) subtopic = 'vocabulary';
        if (lowerText.includes('story') || lowerText.includes('comprehension')) subtopic = 'comprehension';
        return { subject: 'reading', subtopic: subtopic || 'general' };
    }
    if (lowerText.includes('science') || lowerText.includes('animal') || lowerText.includes('space') || lowerText.includes('experiment')) {
        let subtopic = null;
        if (lowerText.includes('animal')) subtopic = 'animals';
        if (lowerText.includes('space') || lowerText.includes('planet') || lowerText.includes('star')) subtopic = 'space';
        return { subject: 'science', subtopic: subtopic || 'general' };
    }
    if (lowerText.includes('music') || lowerText.includes('song') || lowerText.includes('instrument')) {
        let subtopic = null;
        if (lowerText.includes('instrument')) subtopic = 'instruments';
        if (lowerText.includes('rhythm') || lowerText.includes('beat')) subtopic = 'rhythm';
        return { subject: 'music', subtopic: subtopic || 'general' };
    }
    if (lowerText.includes('history') || lowerText.includes('social studies') || lowerText.includes('country')) {
        let subtopic = null;
        if (lowerText.includes('history') || lowerText.includes('past')) subtopic = 'history';
        if (lowerText.includes('geography') || lowerText.includes('map') || lowerText.includes('country')) subtopic = 'geography';
        return { subject: 'socialStudies', subtopic: subtopic || 'general' };
    }
    if (lowerText.includes('sport') || lowerText.includes('exercise') || lowerText.includes('fitness')) {
      let subtopic = null;
      if (lowerText.includes('sport')) subtopic = 'sports';
      if (lowerText.includes('exercise') || lowerText.includes('fitness')) subtopic = 'fitness';
      return { subject: 'pe', subtopic: subtopic || 'general' };
    }
    if (lowerText.includes('code') || lowerText.includes('computer') || lowerText.includes('robot')) {
      let subtopic = null;
      if (lowerText.includes('code') || lowerText.includes('program')) subtopic = 'coding';
      if (lowerText.includes('robot')) subtopic = 'robotics';
      return { subject: 'technology', subtopic: subtopic || 'general' };
    }
    if (lowerText.includes('language') || lowerText.includes('speak') || lowerText.includes('word in spanish') || lowerText.includes('word in french')) {
      let subtopic = null;
      if (lowerText.includes('vocabulary') || lowerText.includes('word')) subtopic = 'vocabulary';
      if (lowerText.includes('grammar') || lowerText.includes('sentence')) subtopic = 'grammar';
      return { subject: 'language', subtopic: subtopic || 'general' };
    }
    return { subject: null, subtopic: null };
}

// Placeholder for generating a more dynamic encouragement
function generateEncouragement(session) {
    const defaultEncouragements = [
        "Keep up the great work!",
        "You're doing wonderfully!",
        "That's fantastic thinking!",
        "Awesome effort!",
        "You're making great progress!"
    ];
    return defaultEncouragements[Math.floor(Math.random() * defaultEncouragements.length)];
}

// Placeholder for generating contextual fallback response
function generateContextualFallback(userMessage, session) {
    const studentName = session.studentName || 'Student';
    return `Oops! My brain had a little hiccup. No worries, ${studentName}! Can you tell me again what you're curious about or if you'd like to try a different math problem?`;
}


// Function to determine max tokens based on grade
function getMaxTokensForGrade(grade) {
  switch (grade) {
    case 'PreK': case 'K': case '1': case '2':
      return 80;
    case '3': case '4': case '5':
      return 100;
    case '6': case '7': case '8':
      return 120;
    case '9': case '10': case '11': case '12':
      return 150;
    default:
      return 100; // Default for undefined grades
  }
}

// --- NEW: Foundational Skill Check Function ---
function checkFoundationalSkills(userMessage, session) {
  const lowerMessage = userMessage.toLowerCase();
  const currentProblem = session.currentProblem || ''; // Store the current problem the AI posed

  // Logic for counting errors in a math context
  if (session.currentTopic === 'math' && session.currentSubtopic === 'addition' || session.currentSubtopic === 'counting' || session.needsFoundationalReview?.skill === 'counting') {
    // Detect clear counting missequences or extremely off answers for simple sums
    const countingErrors = [
      'one two three four five seven eight fifteen', // direct example from chat
      'one three five',
      'two four six',
      'nine five one',
      'zero ten twenty' // Indicates misunderstanding of small number sequence
    ];
    
    // If user's message matches a counting error pattern OR their numerical answer is wildly off for a simple sum
    if (countingErrors.some(error => lowerMessage.includes(error))) {
      // Ensure we capture the problem the AI asked right before this error
      session.currentProblem = session.messages.slice(-2, -1)[0]?.content;
      return { skill: 'counting', originalProblem: session.currentProblem };
    }

    // Heuristic for wildly incorrect answers to simple math problems (e.g., 7+3=97)
    const mathProblemRegex = /(\d+)\s*(plus|\+|\-|\*|\/|times|divided by)\s*(\d+)/;
    const completionMessages = session.messages.filter(m => m.role === 'assistant');
    const lastAIProblem = completionMessages.length > 0 ? completionMessages[completionMessages.length -1].content : '';

    const match = lastAIProblem.match(mathProblemRegex); // Check AI's last message for a math problem
    
    if (match) {
        const num1 = parseFloat(match[1]);
        const num2 = parseFloat(match[3]);
        const operator = match[2];
        let expectedAnswer = null;
        if (operator === '+' || operator === 'plus') expectedAnswer = num1 + num2;
        // Add other operators if needed

        if (expectedAnswer !== null) {
            const userNumericAnswer = parseFloat(lowerMessage.replace(/[^0-9.]/g, '')); // Extract number from user response
            // If user's numerical answer is present and wildly off for a simple sum
            // Define 'wildly off' as being off by more than 5 or 50% of the expected answer for simple sums
            if (!isNaN(userNumericAnswer) && Math.abs(userNumericAnswer - expectedAnswer) > Math.max(5, expectedAnswer * 0.5)) {
                session.currentProblem = lastAIProblem; // Store the actual problem the AI posed
                return { skill: 'counting', originalProblem: session.currentProblem }; // Assume counting is often the root cause for early math errors
            }
        }
    }
  }
  return null; // No foundational skill issue detected
}

// --- CORE AI RESPONSE GENERATION LOGIC ---
async function generateAIResponse(sessionId, userMessage, res) { // Pass 'res' here
  const session = sessions.get(sessionId);
  if (!session) {
      // This case should ideally be caught by the route handler if session doesn't exist
      return res.status(404).json({ error: 'Session not found.' });
  }

  session.messages.push({ role: 'user', content: userMessage, timestamp: Date.now() });
  session.lastActivity = Date.now(); // Update last activity on every message

  // Keep only last few messages (including system prompt) for brevity and context
  // Adjust slice to ensure system prompt is always included and a few user/assistant turns
  // The system message is dynamically generated per call, so it's best to always re-add it first
  const recentMessagesForAI = session.messages.filter(m => m.role !== 'system').slice(-5); // Get last 5 actual chat turns

  // --- Foundational Skill Check BEFORE AI call ---
  let detectedFoundationalIssue = checkFoundationalSkills(userMessage, session);
  if (session.needsFoundationalReview && session.needsFoundationalReview.skill === 'counting') {
      // If we are currently in foundational review, check if counting is mastered
      const lowerMessage = userMessage.toLowerCase();
      // Heuristic for counting mastery: user counts sequentially up to at least 5-10
      const countingMasteryRegex = /(one two three four five six seven eight nine ten)/;
      
      // Also check if they provided a sequence of numbers that is mostly correct and long enough
      const numbersInResponse = lowerMessage.match(/\b\d+\b/g);
      let seemsCountingMastered = false;
      if (countingMasteryRegex.test(lowerMessage)) {
        seemsCountingMastered = true;
      } else if (numbersInResponse && numbersInResponse.length >= 5) {
        let consecutiveCount = 0;
        for (let i = 0; i < numbersInResponse.length - 1; i++) {
          if (parseInt(numbersInResponse[i+1]) === parseInt(numbersInResponse[i]) + 1) {
            consecutiveCount++;
          } else {
            consecutiveCount = 0; // Reset if sequence breaks
          }
          if (consecutiveCount >= 4) { // At least 5 consecutive numbers (e.g., 1,2,3,4,5)
            seemsCountingMastered = true;
            break;
          }
        }
      }

      if (seemsCountingMastered) {
          console.log(`✅ Session ${sessionId.slice(-6)}: Counting skill seems mastered. Returning to original problem.`);
          session.needsFoundationalReview = null; // Clear the flag
          // The next AI prompt will guide it back to the original problem.
      }
  } else if (detectedFoundationalIssue) {
      // If a new foundational issue is detected, set the flag
      session.needsFoundationalReview = detectedFoundationalIssue;
      console.log(`⚠️ Session ${sessionId.slice(-6)}: Foundational skill issue detected: ${detectedFoundationalIssue.skill}. Pivoting lesson.`);
  }

  const messagesToSendToAI = [
    { role: 'system', content: getTutorSystemPrompt(session.grade, session.studentName, session.difficultyLevel, session.needsFoundationalReview) },
    ...recentMessagesForAI // Add the recent actual chat turns
  ];

  try {
    let maxTokens = getMaxTokensForGrade(session.grade);
    if (userMessage.toLowerCase().includes('story')) { // Allow more tokens for stories
      maxTokens = Math.min(maxTokens * 2, 300);
    }
    // Adjust max tokens slightly higher for early grades for less abrupt cutoffs
    if (['PreK', 'K', '1', '2'].includes(session.grade)) {
      maxTokens = Math.max(maxTokens, 80); // Ensure a minimum of 80 tokens for early grades
    } else {
      maxTokens = Math.max(maxTokens, 150); // Ensure a minimum of 150 tokens for others
    }


    const adjustedTemperature = session.difficultyLevel < 0.3 ? 0.5 : (session.difficultyLevel > 0.7 ? 0.8 : config.GPT_TEMPERATURE);

    const completion = await openai.chat.completions.create({
      model: config.GPT_MODEL,
      messages: messagesToSendToAI,
      max_tokens: maxTokens,
      temperature: adjustedTemperature,
      presence_penalty: config.GPT_PRESENCE_PENALTY,
      frequency_penalty: config.GPT_FREQUENCY_PENALTY,
      stop: ["\n\n", "Additionally:", "Furthermore:", "Moreover:"] // Added colons to reduce premature stopping
    });

    let aiText = completion.choices[0].message.content.trim();

    session.messages.push({ role: 'assistant', content: aiText, timestamp: Date.now() });

    // Classify user's input to update session topic tracking
    const { subject, subtopic } = classifySubject(userMessage);
    if (subject) {
      session.topicsDiscussed.add(subject);
      session.currentTopic = subject;
      session.currentSubtopic = subtopic; // Update current subtopic
      session.topicBreakdown[subject] = session.topicBreakdown[subject] || {};
      if (subtopic) {
        session.topicBreakdown[subject][subtopic] = (session.topicBreakdown[subject][subtopic] || 0) + 1;
      }
    }

    const encouragement = generateEncouragement(session);

    // Update difficulty level based on response (placeholder logic)
    const lastUserMessageContent = session.messages.filter(m => m.role === 'user').slice(-1)[0]?.content.toLowerCase();
    if (["i don't know", "i dunno", "tell me", "what is the answer", "break what down", "what are you talking about", "give me something", "you pick one"].some(phrase => lastUserMessageContent.includes(phrase))) {
        session.difficultyLevel = Math.max(0.1, session.difficultyLevel - 0.1); // Decrease difficulty if student is passive
    } else if (aiText.length > 50 && !aiText.includes("wrong") && !aiText.includes("mistake") && !session.needsFoundationalReview) { // Heuristic for progress
        session.difficultyLevel = Math.min(0.9, session.difficultyLevel + 0.05); // Increase difficulty slightly if AI is able to give longer, presumably helpful response
    }

    // Capture the problem AI posed, if it's the start of a new problem
    // This is important for foundational skill return
    if (aiText.includes("apples") || aiText.includes("count") || aiText.includes("problem") || aiText.includes("number")) { // Simple heuristic for a problem
        session.currentProblem = aiText;
    }


    let messageText = aiText; // Start with the raw AI text
    let readingWord = null;

    try {
      const maybeJson = JSON.parse(messageText);
      if (maybeJson && maybeJson.READING_WORD) {
        messageText = maybeJson.message;
        readingWord = maybeJson.READING_WORD;
      }
    } catch (e) { /* Not JSON; keep as regular text */ }

    // This is the line that was missing the 'res' object initially
    res.json({
      response: messageText,
      readingWord: readingWord,
      subject: subject,
      suggestions: generateDynamicSuggestions(session),
      encouragement: encouragement,
      status: 'success',
      sessionStats: {
        totalWarnings: session.totalWarnings || 0,
        topicsDiscussed: Array.from(session.topicsDiscussed)
      }
    });

  } catch (error) {
    console.error(`❌ Error processing chat for session: ${sessionId.slice(-6)}:`, error.message);
    const sessionForFallback = sessions.get(sessionId);

    // This is also where 'res' was undefined previously
    res.status(500).json({
      error: 'Failed to process message due to an internal error. Please try again.',
      fallback: generateContextualFallback(userMessage || '', sessionForFallback || { studentName: 'learner', messages: [] })
    });
  }
}

// --- API ROUTES ---

// Route to initialize a new session
app.post('/api/session/start', (req, res) => {
    const { studentName, grade } = req.body;

    if (!studentName || !config.VALID_GRADES.includes(grade)) {
        return res.status(400).json({ error: 'Student name and valid grade (PreK-12) are required.' });
    }

    const sessionId = generateSessionId();
    const newSession = createSessionObject(sessionId, studentName, grade);
    sessions.set(sessionId, newSession);

    console.log(`✨ New session started: ${sessionId.slice(-6)} for ${studentName} (Grade ${grade})`);

    const welcomeMessage = generateWelcomeMessage(studentName, grade);

    res.status(201).json({
        sessionId: sessionId,
        welcomeMessage: welcomeMessage,
        suggestions: generateSafeSuggestions(grade),
        studentName: studentName,
        grade: grade
    });
});

// Route to handle chat messages
app.post('/api/chat', async (req, res) => {
  const { sessionId, userMessage } = req.body;

  if (!sessionId || !userMessage) {
    return res.status(400).json({ error: 'Session ID and user message are required.' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found. Please start a new session.' });
  }

  // Content moderation check
  const inappropriate = containsInappropriateContent(userMessage);
  if (inappropriate.inappropriate) {
    session.totalWarnings = (session.totalWarnings || 0) + 1;
    const response = getInappropriateResponse(inappropriate.category, session);
    return res.json(response);
  }

  // Call the core AI response generation logic
  await generateAIResponse(sessionId, userMessage, res); // Now correctly passing 'res'
});


app.get('/api/session/:sessionId/summary', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    const topicCounts = {};
    session.conversationContext.forEach(c => {
      if (!c.topic) return;
      topicCounts[c.topic] = (topicCounts[c.topic] || 0) + 1;
    });
    const sortedTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1])[0]; // Get the top one only
    // Correctly calculating total mentions:
    const totalTopicMentions = Object.values(topicCounts).reduce((acc, curr) => acc + curr, 0);


    const highlights = sortedTopics
      ? `${session.studentName} showed strongest interest in: **${capitalize(sortedTopics[0])}** (${Math.round((sortedTopics[1] / totalTopicMentions) * 100)}% of their questions in this area).`
      : 'Showed curiosity and asked thoughtful questions throughout the session.';


    const duration = Math.floor((Date.now() - session.startTime) / 60000);

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
    if (!sessions.delete(sessionId)) {
      return res.status(404).json({ error: 'Session not found or already ended.' });
    }
    console.log(`🛑 Session ${sessionId.slice(-6)} ended manually by user.`);
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
  console.log(`🎓 Enhanced AI Tutor Backend running on port ${config.PORT}`);
  console.log(`📊 Health check: http://localhost:${config.PORT}/api/health`);
  console.log(`🚀 Ready to help students learn safely and effectively!`);
  console.log(`🛡️ Content filtering active for child safety`);
  console.log(`⚠️ Sessions are in-memory and will be lost if the server restarts or expires.`);
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