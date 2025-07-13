const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// --- Enhanced Configuration ---
const config = {
  PORT: process.env.PORT || 3000,
  SESSION_TTL: 45 * 60 * 1000,
  CLEANUP_INTERVAL: 5 * 60 * 1000,
  GPT_MODEL: 'gpt-4o-mini',
  GPT_TEMPERATURE: 0.7,
  VOICE_LEARNING_THRESHOLD: 3, // Number of interactions before voice pattern recognition
  CONFIDENCE_THRESHOLD: 0.7, // Minimum confidence for voice pattern matching
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

// Enhanced voice pattern recognition utilities
const analyzeVoicePattern = (transcript) => {
  const words = transcript.toLowerCase().split(/\s+/);
  const wordCount = words.length;
  const avgWordLength = words.reduce((sum, word) => sum + word.length, 0) / wordCount;
  const commonWords = words.filter(word => ['the', 'and', 'a', 'to', 'of', 'in', 'is', 'it', 'you', 'that', 'he', 'was', 'for', 'on', 'are', 'as', 'with', 'his', 'they', 'i', 'at', 'be', 'this', 'have', 'from', 'or', 'one', 'had', 'by', 'word', 'but', 'not', 'what', 'all', 'were', 'we', 'when', 'your', 'can', 'said', 'there', 'each', 'which', 'she', 'do', 'how', 'their', 'if', 'will', 'up', 'other', 'about', 'out', 'many', 'then', 'them', 'these', 'so', 'some', 'her', 'would', 'make', 'like', 'into', 'him', 'has', 'two', 'more', 'go', 'no', 'way', 'could', 'my', 'than', 'first', 'been', 'call', 'who', 'oil', 'its', 'now', 'find', 'long', 'down', 'day', 'did', 'get', 'come', 'made', 'may', 'part'].includes(word)).length;
  
  return {
    wordCount,
    avgWordLength: Math.round(avgWordLength * 100) / 100,
    commonWordRatio: Math.round((commonWords / wordCount) * 100) / 100,
    lengthCategory: wordCount < 5 ? 'short' : wordCount < 15 ? 'medium' : 'long',
    complexity: avgWordLength > 4.5 ? 'complex' : avgWordLength > 3.5 ? 'medium' : 'simple',
    questionPattern: /\?/.test(transcript),
    exclamationPattern: /!/.test(transcript),
    pausePattern: /\b(um|uh|er|hmm|like|you know)\b/gi.test(transcript)
  };
};

const calculateVoiceConfidence = (currentPattern, learnedPattern) => {
  if (!learnedPattern) return 0;
  
  let confidence = 0;
  let factors = 0;
  
  // Word count similarity
  const wordCountDiff = Math.abs(currentPattern.wordCount - learnedPattern.avgWordCount) / learnedPattern.avgWordCount;
  confidence += Math.max(0, 1 - wordCountDiff);
  factors++;
  
  // Average word length similarity
  const wordLengthDiff = Math.abs(currentPattern.avgWordLength - learnedPattern.avgWordLength) / learnedPattern.avgWordLength;
  confidence += Math.max(0, 1 - wordLengthDiff);
  factors++;
  
  // Common word ratio similarity
  const commonWordDiff = Math.abs(currentPattern.commonWordRatio - learnedPattern.avgCommonWordRatio);
  confidence += Math.max(0, 1 - commonWordDiff);
  factors++;
  
  // Length category match
  if (currentPattern.lengthCategory === learnedPattern.dominantLengthCategory) {
    confidence += 0.5;
    factors += 0.5;
  }
  
  // Complexity match
  if (currentPattern.complexity === learnedPattern.dominantComplexity) {
    confidence += 0.3;
    factors += 0.3;
  }
  
  return factors > 0 ? confidence / factors : 0;
};

// Enhanced conversation flow detection
const detectConversationFlow = (message, session) => {
  const lastMessage = session.messages[session.messages.length - 1];
  const secondLastMessage = session.messages[session.messages.length - 2];
  
  // Check if AI just asked a question
  const aiJustAskedQuestion = lastMessage?.role === 'assistant' && /\?/.test(lastMessage.content);
  
  // Check if this looks like AI continuing its own thought
  const looksLikeAISelfResponse = aiJustAskedQuestion && 
    secondLastMessage?.role === 'assistant' && 
    Date.now() - (lastMessage.timestamp?.getTime() || 0) < 2000; // Less than 2 seconds ago
  
  // Check for rapid consecutive messages (possible echo/feedback)
  const rapidConsecutive = session.conversationContext.length > 1 && 
    Date.now() - session.conversationContext[session.conversationContext.length - 1].timestamp < 1000;
  
  return {
    aiJustAskedQuestion,
    looksLikeAISelfResponse,
    rapidConsecutive,
    shouldPause: looksLikeAISelfResponse || rapidConsecutive
  };
};

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
  return level <= 2 ? 60 : level <= 5 ? 80 : level <= 8 ? 100 : 125;
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

  return `You are an AI Tutor for ${name}. You are patient, encouraging, and help students learn step by step.

CRITICAL CONVERSATION RULES:
- WAIT for ${name} to respond before continuing
- NEVER answer your own questions
- If you ask a question, STOP and wait for their answer
- Keep responses ${responseLength[grade] || '2-3 sentences'}
- Use age-appropriate language for grade ${grade}
- Be encouraging and celebrate small wins
- If they get something wrong, gently guide them to the right answer
- Show your thinking process step by step
- Avoid lecturing - make it conversational
- If they seem confused, break it down into smaller steps

CONVERSATION FLOW:
1. Listen to what ${name} says
2. Respond appropriately 
3. If asking a question, WAIT for their response
4. Build on their answers to keep learning fun

Remember: You're having a conversation WITH ${name}, not AT them.
${readingInstruction}`;
};

const generateResponse = (type, name, grade) => {
  const responses = {
    welcome: {
      'PreK': `Hi ${name}! I'm excited to learn with you today!`, 
      'K': `Hello ${name}! What fun thing should we explore?`,
      '1': `Hi ${name}! I'm your learning buddy. What interests you?`, 
      '2': `Hey ${name}! Ready for some fun learning?`,
      '3': `Hi ${name}! What would you like to discover today?`, 
      '4': `Hello ${name}! I'm here to help you learn cool things!`,
      '5': `Hi ${name}! What subject sounds interesting to you?`, 
      '6': `Hey ${name}! What's something you've been curious about?`,
      '7': `Hi ${name}! What topic should we dive into?`, 
      '8': `Hello ${name}! What would you like to explore together?`,
      '9': `Hi ${name}! What can I help you learn today?`, 
      '10': `Hey ${name}! What subject interests you most?`,
      '11': `Hello ${name}! What topic would you like to discuss?`, 
      '12': `Hi ${name}! What should we explore together?`
    },
    redirect: `I'm here to help you learn amazing things, ${name}! What would you like to explore today?`,
    encourage: [`Great job, ${name}!`, `You're doing awesome!`, `I love how you're thinking!`, `That's wonderful curiosity!`, `You're such a good learner!`],
    listening: [`I'm listening, ${name}!`, `Take your time, ${name}!`, `Go ahead, I'm here!`, `What were you thinking, ${name}?`],
    pause: [`Let me wait for you to answer, ${name}!`, `I want to hear what you think first!`, `Your turn, ${name}!`],
    suggestions: {
      early: ['Let\'s count together!', 'What about colors?', 'Tell me about animals!'],
      middle: ['Want to try some math?', 'How about a story?', 'Let\'s explore science!'],
      high: ['Ready for a challenge?', 'What\'s puzzling you?', 'Let\'s solve something!']
    }
  };
  
  if (type === 'welcome') return responses.welcome[grade] || responses.welcome['K'];
  if (type === 'redirect') return responses.redirect;
  if (type === 'encourage') return responses.encourage[Math.floor(Math.random() * responses.encourage.length)];
  if (type === 'listening') return responses.listening[Math.floor(Math.random() * responses.listening.length)];
  if (type === 'pause') return responses.pause[Math.floor(Math.random() * responses.pause.length)];
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
  voiceInteractions: 0,
  messages: [{ role: 'system', content: getTutorPrompt(grade, name), timestamp: new Date() }],
  topicsDiscussed: new Set(), 
  conversationContext: [],
  
  // Enhanced voice recognition tracking
  voicePatterns: [],
  learnedVoicePattern: null,
  voiceConfidenceHistory: [],
  backgroundVoiceDetected: 0,
  
  // Conversation flow tracking
  waitingForResponse: false,
  lastQuestionTime: null,
  conversationPaused: false
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
    const { sessionId, message, voiceMetadata } = req.body;
    
    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({ error: 'Invalid session' });
    }
    
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }
    
    const session = sessions.get(sessionId);
    session.lastActivity = Date.now();
    
    const cleanedMessage = message.trim();
    
    // Analyze voice pattern for this message
    const currentVoicePattern = analyzeVoicePattern(cleanedMessage);
    session.voicePatterns.push({
      pattern: currentVoicePattern,
      timestamp: Date.now(),
      message: cleanedMessage
    });
    
    // Build learned voice pattern after enough interactions
    if (session.voicePatterns.length >= config.VOICE_LEARNING_THRESHOLD && !session.learnedVoicePattern) {
      const patterns = session.voicePatterns.map(vp => vp.pattern);
      session.learnedVoicePattern = {
        avgWordCount: patterns.reduce((sum, p) => sum + p.wordCount, 0) / patterns.length,
        avgWordLength: patterns.reduce((sum, p) => sum + p.avgWordLength, 0) / patterns.length,
        avgCommonWordRatio: patterns.reduce((sum, p) => sum + p.commonWordRatio, 0) / patterns.length,
        dominantLengthCategory: patterns.map(p => p.lengthCategory).sort((a,b) => 
          patterns.filter(p => p.lengthCategory === a).length - patterns.filter(p => p.lengthCategory === b).length
        ).pop(),
        dominantComplexity: patterns.map(p => p.complexity).sort((a,b) => 
          patterns.filter(p => p.complexity === a).length - patterns.filter(p => p.complexity === b).length
        ).pop()
      };
      console.log(`🎯 Voice pattern learned for session ${sessionId.slice(-6)}`);
    }
    
    // Calculate voice confidence if we have a learned pattern
    let voiceConfidence = 1; // Default to accepting
    if (session.learnedVoicePattern) {
      voiceConfidence = calculateVoiceConfidence(currentVoicePattern, session.learnedVoicePattern);
      session.voiceConfidenceHistory.push(voiceConfidence);
      
      // If confidence is too low, this might be background voice
      if (voiceConfidence < config.CONFIDENCE_THRESHOLD) {
        session.backgroundVoiceDetected++;
        console.log(`🔇 Low confidence voice detected in session ${sessionId.slice(-6)}: ${voiceConfidence.toFixed(2)}`);
        
        return res.json({
          response: `I'm listening for ${session.studentName}. Can you speak up?`,
          status: 'waiting_for_main_user',
          voiceConfidence: voiceConfidence,
          suggestions: ["Try speaking closer to the microphone", "Make sure you're the only one talking"]
        });
      }
    }
    
    // Detect conversation flow issues
    const flowAnalysis = detectConversationFlow(cleanedMessage, session);
    
    if (flowAnalysis.shouldPause) {
      console.log(`⏸️ Conversation flow pause detected in session ${sessionId.slice(-6)}`);
      return res.json({
        response: generateResponse('pause', session.studentName),
        status: 'paused',
        suggestions: generateResponse('suggestions', null, session.grade)
      });
    }
    
    // Handle thinking pauses
    if (cleanedMessage.length < 3 || /^(um+|uh+|er+|hmm+)$/i.test(cleanedMessage)) {
      return res.json({
        response: generateResponse('listening', session.studentName),
        suggestions: ["Take your time!", "I'm here!", "What were you thinking?"],
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
    
    // Clear waiting state if we were waiting for a response
    if (session.waitingForResponse) {
      session.waitingForResponse = false;
      session.conversationPaused = false;
    }
    
    // Add user message
    session.messages.push({ role: 'user', content: cleanedMessage, timestamp: new Date() });
    session.voiceInteractions++;
    
    // Keep conversation manageable
    if (session.messages.length > 10) {
      session.messages = [session.messages[0], ...session.messages.slice(-9)];
    }
    
    // Generate AI response with enhanced conversation awareness
    const systemPrompt = session.messages[0].content + `\n\nCONVERSATION CONTEXT: You just received a message from ${session.studentName}. Voice confidence: ${(voiceConfidence * 100).toFixed(0)}%. This is interaction #${session.voiceInteractions}. Remember to wait for their response if you ask a question.`;
    
    const messagesForAI = [
      { role: 'system', content: systemPrompt },
      ...session.messages.slice(1).map(m => ({ role: m.role, content: m.content }))
    ];
    
    const completion = await openai.chat.completions.create({
      model: config.GPT_MODEL,
      messages: messagesForAI,
      max_tokens: getMaxTokens(session.grade),
      temperature: config.GPT_TEMPERATURE,
      stop: ["\n\n", "Additionally,", "Furthermore,", "Also,", "In addition,"]
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
    
    // Check if AI asked a question
    const aiAskedQuestion = /\?/.test(aiResponse);
    if (aiAskedQuestion) {
      session.waitingForResponse = true;
      session.lastQuestionTime = Date.now();
    }
    
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
    
    if (session.conversationContext.length > 8) {
      session.conversationContext = session.conversationContext.slice(-8);
    }
    
    res.json({
      response: aiResponse,
      readingWord,
      subject,
      suggestions: generateResponse('suggestions', null, session.grade),
      encouragement: generateResponse('encourage', session.studentName),
      status: 'success',
      voiceConfidence: Math.round(voiceConfidence * 100),
      waitingForResponse: session.waitingForResponse,
      sessionStats: {
        totalWarnings: session.totalWarnings,
        topicsDiscussed: Array.from(session.topicsDiscussed),
        voiceInteractions: session.voiceInteractions,
        backgroundVoiceDetected: session.backgroundVoiceDetected,
        avgVoiceConfidence: session.voiceConfidenceHistory.length > 0 ? 
          Math.round((session.voiceConfidenceHistory.reduce((a,b) => a + b, 0) / session.voiceConfidenceHistory.length) * 100) : 100
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
    const avgConfidence = session.voiceConfidenceHistory.length > 0 ? 
      Math.round((session.voiceConfidenceHistory.reduce((a,b) => a + b, 0) / session.voiceConfidenceHistory.length) * 100) : 100;
    
    res.json({
      duration: duration > 0 ? `${duration} minutes` : 'Less than a minute',
      totalWarnings: session.totalWarnings,
      voiceInteractions: session.voiceInteractions,
      avgVoiceConfidence: avgConfidence,
      backgroundVoiceDetected: session.backgroundVoiceDetected,
      topicsExplored: topics.length ? `Explored: ${topics.join(', ')}` : 'General conversation',
      studentName: session.studentName,
      grade: session.grade,
      highlights: [`${session.studentName} engaged well in ${session.voiceInteractions} interactions!`],
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
    topics: Array.from(session.topicsDiscussed),
    voiceConfidence: session.voiceConfidenceHistory.length > 0 ? 
      Math.round((session.voiceConfidenceHistory.reduce((a,b) => a + b, 0) / session.voiceConfidenceHistory.length) * 100) : 100,
    waitingForResponse: session.waitingForResponse
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
  console.log(`🎓 Enhanced AI Tutor Backend running on port ${config.PORT}`);
  console.log(`🚀 Ready to help students learn with voice recognition!`);
});

// Graceful shutdown
['SIGTERM', 'SIGINT'].forEach(signal => {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
  });
});

module.exports = app;