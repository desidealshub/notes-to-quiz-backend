const xss = require('xss');
const crypto = require('crypto');
const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const admin = require('firebase-admin');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

// 1. FIREBASE SECURE CONNECTION
try {
    let serviceAccount;
    
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        console.log("🟢 Loaded Firebase credentials from Environment Variable.");
    } else {
        serviceAccount = require('./serviceAccountKey.json');
        console.log("🟡 Loaded Firebase credentials from local serviceAccountKey.json file.");
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    
    console.log("✅ Firebase Admin Connected Successfully!");
} catch (err) {
    console.error("🚨 Firebase Init Error:", err);
}

const db = admin.firestore();
const app = express();
app.set('trust proxy', 1); // 🔥 Fixes the X-Forwarded-For Render warning

// Configure multer for memory storage (Max 10MB per file)
upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// ==========================================
// --- SECURITY & MIDDLEWARE CONFIGURATION ---
// ==========================================

app.use(helmet());

// 🔥 1. STRICT CORS POLICY (Hackers block karne ke liye)
allowedOrigins = [
    'https://desidealshub.com', 
    'https://quiz.desidealshub.com', 
    'http://localhost:3000',
    'http://localhost:5500', 
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('CORS Policy Error: Unauthorized Access'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ANTI-DDOS / SPAM GUARD
apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 50, 
    message: { 
        success: false, 
        error: "Aram se bhai! Bahut zyada requests aagayi hain. 15 minute baad try kar." 
    },
    standardHeaders: true, 
    legacyHeaders: false, 
});
app.use('/api/', apiLimiter);

// ==========================================
// --- INITIALIZE RAZORPAY & AI CLIENT ---
// ==========================================

razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummykey',
    key_secret: process.env.RAZORPAY_SECRET || 'dummysecret'
});

// 🔥 GEMINI AI SDK SETUP (MULTI-KEY FALLBACK ADDED HERE) 🔥
const { GoogleGenAI } = require('@google/genai');
const rawKeys = process.env.GEMINI_API_KEY || 'dummykey';
const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(k => k);
const aiClients = apiKeys.map(key => new GoogleGenAI({ apiKey: key }));
let currentClientIndex = 0;
// Master AI Generation Function (Now Smart & Flexible)
async function generateAIContent(parts, isJsonMode = false) {
    let attempts = 0;
    maxRetries = 3;
    let lastError;

    while (attempts < maxRetries) {
        try {
            ai = aiClients[currentClientIndex];
            
            // Setting config dynamically based on what the route needs
            configParams = {};
            if (isJsonMode) {
                configParams.responseMimeType = "application/json";
            }

            response = await ai.models.generateContent({
                model: 'gemini-1.5-flash',
                contents: parts,
                config: configParams
            });
            
            return response;
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ Gemini Key ${currentClientIndex + 1} failed (Status: ${err.status || 'Unknown'}). Retrying...`);
            
            if (err.status === 429 || err.status === 503) {
                currentClientIndex = (currentClientIndex + 1) % aiClients.length;
                console.log(`🔄 Switched to Backup API Key ${currentClientIndex + 1}`);
            }
            attempts++;
            await new Promise(resolve => setTimeout(resolve, attempts * 2000));
        }
    }
    throw lastError;
}

// ==========================================
// --- AUTHENTICATION MIDDLEWARE ---
// ==========================================
verifyAuthToken = async (req, res, next) => {
    try {
        authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(token);
            req.user = { uid: decodedToken.uid, email: decodedToken.email, name: decodedToken.name || 'User' };
        } else {
            req.user = { uid: 'guest_user', email: 'guest@desidealshub.com', name: 'Guest' };
        }
        next();
    } catch (error) {
        console.warn("⚠️ Auth token verification failed, falling back to guest:", error.message);
        req.user = { uid: 'guest_user', email: 'guest@desidealshub.com', name: 'Guest' };
        next();
    }
};
app.use('/api/v1/', verifyAuthToken);

// =======================================================================
// 🔥 UNIVERSAL PROMPT ENGINEERING (EXAM & SUBJECT SPECIFIC ARCHETYPES) 🔥
// =======================================================================
function buildExamPersona(academicLevel, board = null, stream = null, medium = null, subject = null, difficulty = 'medium') {
    let examStyle = "";
    const target = academicLevel ? academicLevel.toLowerCase() : "";
    const sub = subject ? subject.toLowerCase() : "";

    // 🚨 1. EXAM & SUBJECT SPECIFIC TONE 🚨
    if (target === 'jee_adv') {
        examStyle = `🚨 JEE ADVANCED MODE: Generate highly complex, multi-layered comprehension-style paragraphs. For ${subject}, intertwine 2-3 distinct advanced chapters. Force the student to solve for hidden variables before the main calculation. Options should be abstract expressions. Requires rigorous mathematical steps.`;
    } else if (target === 'jee_mains') {
        examStyle = `🚨 JEE MAINS MODE: Generate tricky, speed-breaker numericals mirroring NTA 2024 patterns. For ${subject}, focus on calculation traps, edge cases in formulas, and algebraic manipulations.`;
    } else if (target === 'neet') {
        if (sub.includes('physics')) {
            examStyle = `🚨 NEET PHYSICS MODE: Focus on formula application, conceptual tricks, and speed. Avoid lengthy calculus. Use assertion-reasoning or statement-based questions.`;
        } else if (sub.includes('biology') || sub.includes('botany') || sub.includes('zoology')) {
            examStyle = `🚨 NEET BIOLOGY MODE: Focus on deep NCERT line-by-line factual recall, matching lists, and assertion-reasoning.`;
        } else {
            examStyle = `🚨 NEET MODE: Focus on speed, factual accuracy, and direct conceptual application mirroring NTA NEET patterns.`;
        }
    } else if (target === 'ssc' || target === 'banking' || target === 'railway' || target === 'bihar_police') {
        if (sub.includes('math') || sub.includes('aptitude') || sub.includes('quant')) {
            examStyle = `🚨 COMPETITIVE QUANT MODE: Focus on arithmetic shortcuts, percentages, time-speed-distance, and geometry tricks. Use tricky distractors that match common calculation errors.`;
        } else if (sub.includes('reasoning') || sub.includes('intelligence')) {
            examStyle = `🚨 REASONING MODE: Focus on deep logical puzzles, syllogisms, and coding-decoding.`;
        } else if (sub.includes('english')) {
            examStyle = `🚨 ENGLISH COMPREHENSION MODE: Focus on complex spotting errors, idioms, and vocabulary.`;
        } else {
            examStyle = `🚨 GK/AWARENESS MODE: Focus on exact dates, articles of the constitution, recent events, or specific historical facts.`;
        }
    } else if (target === 'class12' || target === 'class10') {
        examStyle = `🚨 BOARD EXAM MODE (${board || 'CBSE'}): Mirror the exact pattern of board exams. Use case-study based questions, assertion-reasoning, and standard conceptual proofs.`;
    } else {
        examStyle = `🚨 COMPETITIVE MODE: Adapt strictly to the ${academicLevel} standard for ${subject}.`;
    }

    // 🚨 2. DIFFICULTY SCALING 🚨
    let diffRules = "";
    if (difficulty.toLowerCase() === 'hard') {
        diffRules = `🔥 DIFFICULTY: HARD. DO NOT ask single-step or direct formula questions. Make the scenario complex. Mix multiple concepts. Hide direct data and make the student derive it first.`;
    } else if (difficulty.toLowerCase() === 'easy') {
        diffRules = `Difficulty: Easy. Focus on fundamental concepts, direct definitions, and basic formula applications.`;
    } else {
        diffRules = `Difficulty: Medium. Standard previous year question level with moderate calculations.`;
    }

    // 🚨 3. LANGUAGE INSTRUCTION 🚨
    let mediumText = "";
    if (sub.includes("english") || medium === "English") {
        mediumText = "CRITICAL LANGUAGE RULE: Entire output (questions, options, explanations) MUST be in PROFESSIONAL ENGLISH.";
    } else if (medium === "Hindi") {
        mediumText = "CRITICAL LANGUAGE RULE: The questions, options (A,B,C,D), and explanations MUST be entirely in PURE HINDI (Devanagari script). However, strictly retain all technical Math/Science formulas, variables, and equations in English LaTeX enclosed in '$'. DO NOT translate math variables to Hindi.";
    }

    return `Target Exam: ${academicLevel || 'Competitive Test'} | Subject: ${subject || 'General'}\n${examStyle}\n${diffRules}\n${mediumText}`;
}
// 🔥 SOLUTION: SMART MATH/LANGUAGE FORMATTING, NO STARS, STEP-BY-STEP EXPLANATION, NO JSON CRASH
const strictNegativeRules = `
⚠️ STRICT NEGATIVE RULES & QUALITY ASSURANCE (DO NOT BREAK THESE):
1. 🎯 100% FACTUAL ACCURACY: The 'correctAnswer' MUST be indisputably correct. Do NOT hallucinate.
2. 📅 DEEP DATA & PYQ INTEGRATION: Ask highly specific questions mirroring official exams.
3. 🚫 NO META-QUESTIONS: NEVER reference the notes themselves.
4. 🔥 PLAUSIBLE DISTRACTORS: Incorrect options MUST be common student mistakes.
5. 🧮 SMART FORMATTING (CRITICAL PREVENT CRASH): 
   - ⚠️ IF the subject is Math, Physics, Chemistry, or Science: You MUST use standard LaTeX enclosed in SINGLE '$' signs for ALL equations, variables, and formulas (e.g., $\\frac{1}{2}$). DO NOT use double '$$'. Avoid using single quotes in math (use ^\\prime instead).
   - ⚠️ IF the subject is a Language (Hindi, English, Sanskrit) or Humanities (History, Polity): DO NOT use LaTeX '$' signs. Output normal plain text with standard punctuation.
6. ⚡ EXPLANATION DEPTH & FORMATTING RULE: 
   - Keep options (A, B, C, D) EXTREMELY SHORT AND CRISP.
   - Provide a HIGHLY DETAILED, step-by-step logical proof or reasoning in the 'explanation' field. 
   - 🚨 YOU MUST insert the exact HTML tag <br><br> between every single step or paragraph to force line breaks in the UI. DO NOT write a single dense paragraph.
7. ❌ ABSOLUTELY NO MARKDOWN FORMATTING IN TEXT: 
   - NEVER use asterisks (**) or underscores (__) for bolding or emphasis. Just use plain text. DO NOT use markdown code blocks inside the explanation.
8. WARNING: Return PURE JSON ARRAY ONLY. NO markdown tags like \`\`\`json. NO introductory or closing text.
9. 🚨 NO HTML ENTITIES: NEVER use HTML codes like &gt;, &lt;, or &#39;. Always use raw symbols (<, >, ') directly in your text.`;
// 🔥 SOLUTION: BULLETPROOF MATH & JSON PARSER
// Ye function ensure karega ki agar AI galti se single backslash bhej de, toh server usko auto-fix karke crash hone se bacha le.
function safeJSONParse(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        try {
            // Markdown backticks remove karo
            let cleanStr = str.replace(/```json/gi, '').replace(/```/gi, '').trim();
            // Single backslash ko double me convert karo (sirf unhe jo standard JSON escapes nahi hain)
            cleanStr = cleanStr.replace(/\\(?!["\\/bfnrt])/g, "\\\\"); 
            return JSON.parse(cleanStr);
        } catch (fatalError) {
            console.error("🚨 FATAL JSON PARSE ERROR. AI Output was:", str);
            throw new Error("Mathematical formatting generated by AI caused a glitch. Please try again.");
        }
    }
}


// ==========================================
// --- API ROUTES ---
// ==========================================

app.get('/', (req, res) => {
    res.json({ status: 'NotesToQuiz Production Backend is Live & Secure 🚀' });
});

// 🔥 SOLUTION: SPEED DELAY (WAKE UP ROUTE)
// Frontend jaise hi khulega, is route par ek silent ping marega taaki Render ka server 50 seconds pehle hi jaag jaye.
app.get('/api/ping', (req, res) => {
    res.status(200).send('PONG - Server is awake!');
});

// 🔥 SOLUTION: "CHAT WITH SOLUTION" (AI TUTOR FEATURE)
// Bachhe ko agar explanation samajh na aaye, toh wo AI se cross-question kar sakega.
app.post('/api/v1/chat-tutor', async (req, res) => {
    try {
        const { question, options, correctAnswer, explanation, studentDoubt } = req.body;
        
        const prompt = `You are a friendly and expert AI tutor for a student. 
        The student encountered this question in a mock test:
        Question: ${question}
        Correct Answer: ${correctAnswer} (${options[correctAnswer]})
        Official Explanation: ${explanation}
        
        The student is confused and asks this doubt: "${studentDoubt}"
        
        YOUR TASK: Explain the concept step-by-step in a very simple, easy-to-understand tone. Use Hinglish if the doubt feels casual. Keep it encouraging. Max 4-5 short paragraphs. DO NOT use markdown code blocks, just plain text with basic bolding.`;
        
        const response = await generateAIContent([{ text: prompt }], false);
        res.status(200).json({ success: true, answer: response.text });
    } catch (error) {
        console.error("Chat Tutor Error:", error);
        res.status(500).json({ success: false, error: "Tutor is currently busy. Please try again." });
    }
});
// 🔥 SOLUTION: "CHAT WITH SOLUTION" (AI TUTOR FEATURE - NO STARS, NO GRAPHS)
app.post('/api/v1/chat-tutor', async (req, res) => {
    try {
        const { question, options, correctAnswer, explanation, studentDoubt } = req.body;
        
        const prompt = `You are a friendly and expert AI tutor for a student. 
        The student encountered this question in a mock test:
        Question: ${question}
        Correct Answer: ${correctAnswer} (${options[correctAnswer]})
        Official Explanation: ${explanation}
        
        The student is confused and asks this doubt: "${studentDoubt}"
        
        YOUR TASK: Explain the concept step-by-step in a very simple, easy-to-understand tone.
        
        🚨 CRITICAL RULES FOR AI TUTOR (DO NOT BREAK):
        1. NO MARKDOWN: NEVER use asterisks (**) or underscores (__) for bolding. If you need to emphasize, use standard HTML <b>tags</b>.
        2. NO ASCII GRAPHS: NEVER try to draw y-axis/x-axis graphs using text characters (like |, -, *). It breaks the mobile UI. 
        3. MATH FORMATTING: Wrap all mathematical variables, expressions, and equations in single '$' signs for LaTeX rendering.
        4. SPACING: Use the exact HTML tag <br><br> for line breaks between paragraphs to keep it readable.`;
        
        const response = await generateAIContent([{ text: prompt }], false);
        res.status(200).json({ success: true, answer: response.text });
    } catch (error) {
        console.error("Chat Tutor Error:", error);
        res.status(500).json({ success: false, error: "Tutor is currently busy. Please try again." });
    }
});
// ======================================================================= //
// 🔥 1. INDIVIDUAL STUDENT QUIZ GENERATION (UPLOAD NOTES) 🔥 //
// =======================================================================
app.post('/api/v1/generate-quiz', upload.array('files', 5), async (req, res) => {
    let userId = req.user.uid;
    let requiredCredits = 0;
    let creditsDeducted = false;

    try {
        let config = req.body.config ? JSON.parse(req.body.config) : req.body;
        const { subject, questionCount, academicLevel } = config;
        
        // 🔥 SOLUTION: SERVER-SIDE PRICING ENFORCEMENT
        // Client side par chahe jo price dikh raha ho, deduction exactly is formula se hoga backend par.
        const qCount = Math.min(Math.max(Number(questionCount) || 10, 5), 150); // Cap between 5 and 150
        requiredCredits = Math.max(3, Math.ceil(qCount * 0.5));
        let finalRemainingCredits = "Skipped (Guest)";

        // 🔥 SOLUTION: BULLETPROOF GUEST LOGIC (IP ADDRESS FINGERPRINTING)
        if (userId === 'guest_user') {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            const ipHash = crypto.createHash('sha256').update(clientIp).digest('hex'); // Stronger Hash
            const ipRef = db.collection('GuestLimits').doc(ipHash);
            
            await db.runTransaction(async (transaction) => {
                const ipDoc = await transaction.get(ipRef);
                let attempts = 0;
                if (ipDoc.exists) attempts = ipDoc.data().attempts || 0;
                
                // Strict 2 limit enforcement on Database level
                if (attempts >= 2) {
                    throw new Error("GUEST_LIMIT_REACHED");
                }
                transaction.set(ipRef, { 
                    attempts: attempts + 1, 
                    lastUsed: admin.firestore.FieldValue.serverTimestamp(),
                    ip: clientIp 
                }, { merge: true });
            });
        }

        // 1. DEDUCT CREDITS SAFELY & CHECK PLAN LIMITS
        if (userId !== 'guest_user') {
            const userRef = db.collection('users').doc(userId);
            await db.runTransaction(async (transaction) => {
                const userDoc = await transaction.get(userRef);
                let currentCredits = 30;
                let userPlan = 'Free';
                if (userDoc.exists) {
                    if (userDoc.data().credits !== undefined) currentCredits = Number(userDoc.data().credits);
                    if (userDoc.data().plan !== undefined) userPlan = userDoc.data().plan;
                }

                let maxAllowedQs = 15; 
                if (userPlan === 'Pro') maxAllowedQs = 25;
                if (userPlan === 'Elite') maxAllowedQs = 60;
                if (userPlan === 'Institute') maxAllowedQs = 150;

                if (qCount > maxAllowedQs) {
                    throw new Error(`Plan Limit Exceeded! Your current plan (${userPlan}) allows a maximum of ${maxAllowedQs} questions per test. Upgrade to unlock more.`);
                }

                if (currentCredits < requiredCredits) throw new Error(`Insufficient credits! You need ${requiredCredits} but have ${currentCredits}.`);
                
                finalRemainingCredits = currentCredits - requiredCredits;
                transaction.set(userRef, { credits: finalRemainingCredits }, { merge: true });
            });
            creditsDeducted = true; 
        }

        const finalSubject = (subject && subject.trim() !== "") ? subject : "Auto-Detected";
        
        const prompt = `You are a ruthless and expert academic examiner. Analyze the attached image/file carefully. 
        YOUR TASK: Extract the core TOPICS, FORMULAS, and CONCEPTS from these notes. Then, generate exactly ${qCount} Multiple Choice Questions (MCQs) testing those specific concepts.
        Subject context: "${finalSubject}"
        
        ${buildExamPersona(academicLevel, null, null, null, finalSubject)}
        ${strictNegativeRules}`;
        
        const parts = [{ text: prompt }];
        let totalSize = 0;
        if (req.files) {
            req.files.forEach(file => {
                totalSize += file.size;
                parts.push({ inlineData: { data: file.buffer.toString("base64"), mimeType: file.mimetype } });
            });
            if (totalSize > 8 * 1024 * 1024) {
                throw new Error("Uploaded files are too large. Max 8MB total allowed.");
            }
        }

        const response = await generateAIContent(parts, true);
        
        // 🔥 SOLUTION: APPLYING THE SAFE JSON PARSER
        const quizArray = safeJSONParse(response.text);

        res.status(200).json({ success: true, quizArray, remainingCredits: finalRemainingCredits });

    } catch (error) {
        console.error("🚨 Individual Generation Error:", error.message);

        // Default Clean Message
        let cleanErrorMessage = "Oops! Something went wrong while generating the test. Please try again.";
        
        // 1. BUSINESS LOGIC ERRORS (Tere purane errors jo user ko dikhne chahiye)
        if (error.message === "GUEST_LIMIT_REACHED") {
            cleanErrorMessage = "Free trial exhausted for this device/IP. Please log in with Google to continue generating unlimited tests.";
        } else if (error.message.includes("Plan Limit") || error.message.includes("Insufficient credits") || error.message.includes("large")) {
            cleanErrorMessage = error.message; 
        } 
        // 2. GOOGLE AI API ERRORS (Naya Smart Interceptor)
        else if (error.message.includes("Quota exceeded") || error.message.includes("429")) {
            cleanErrorMessage = "Server is currently busy with high traffic. Please wait 1 minute and click generate again.";
        } else if (error.message.includes("503") || error.message.includes("overloaded")) {
            cleanErrorMessage = "The AI engine is temporarily overloaded. Please try again in 10 seconds.";
        } else if (error.message.includes("JSON") || error.message.includes("parse")) {
            cleanErrorMessage = "There was a formatting issue with the generated questions. Please regenerate.";
        } else if (error.message.includes("Safety") || error.message.includes("blocked")) {
            cleanErrorMessage = "Your notes contain restricted or unclear content. Please upload a clearer document.";
        }

        // AUTO-REFUND MECHANIC (Only refund if it wasn't a guest error or validation error)
        if (userId !== 'guest_user' && creditsDeducted) {
            try {
                const userRef = db.collection('users').doc(userId);
                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    if (userDoc.exists) {
                        let currentCredits = Number(userDoc.data().credits || 0);
                        transaction.set(userRef, { credits: currentCredits + requiredCredits }, { merge: true });
                        console.log(`♻️ Auto-refunded ${requiredCredits} credits to user ${userId}`);
                    }
                });
            } catch (refundErr) {
                console.error("🚨 Refund Transaction Failed:", refundErr);
            }
        }

        // 🔥 THE MAIN FIX: Raw 'error.message' ki jagah cleanErrorMessage bhej rahe hain
        res.status(500).json({ 
            success: false, 
            error: cleanErrorMessage 
        });
    }
});


// ======================================================================= //
// 🔥 1.B CUSTOM TEST GENERATION (NO UPLOADS - RTS STYLE) 🔥 //
// =======================================================================
app.post('/api/v1/generate-custom-test', async (req, res) => {
    let userId = req.user ? req.user.uid : 'guest_user';
    let requiredCredits = 0;
    let creditsDeducted = false;

    try {
        let { targetExam, subject, chapter, difficulty, questionCount, board, stream, medium } = req.body;
        const qCount = Number(questionCount) || 10;
        
        // Hindi Auto-Detect for BSEB
        if (!medium && (board === 'Bihar Board' || board === 'BSEB (Bihar Board)' || targetExam === 'Bihar Board')) {
            medium = 'Hindi'; 
        }

        requiredCredits = Math.max(2, Math.ceil(qCount * 0.4)); 
        let finalRemainingCredits = "Skipped (Guest)";

        if (userId === 'guest_user') {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            const ipHash = crypto.createHash('sha256').update(clientIp).digest('hex'); 
            const ipRef = db.collection('GuestLimits').doc(ipHash);
            
            await db.runTransaction(async (transaction) => {
                const ipDoc = await transaction.get(ipRef);
                let attempts = 0;
                if (ipDoc.exists) attempts = ipDoc.data().attempts || 0;
                if (attempts >= 2) throw new Error("GUEST_LIMIT_REACHED");
                
                transaction.set(ipRef, { attempts: attempts + 1, lastUsed: admin.firestore.FieldValue.serverTimestamp(), ip: clientIp }, { merge: true });
            });
        } else {
            const userRef = db.collection('users').doc(userId);
            await db.runTransaction(async (transaction) => {
                const userDoc = await transaction.get(userRef);
                let currentCredits = 30, userPlan = 'Free';
                if (userDoc.exists) {
                    if (userDoc.data().credits !== undefined) currentCredits = Number(userDoc.data().credits);
                    if (userDoc.data().plan !== undefined) userPlan = userDoc.data().plan;
                }

                let maxAllowedQs = 15; 
                if (userPlan === 'Pro') maxAllowedQs = 25;
                if (userPlan === 'Elite') maxAllowedQs = 60;
                if (userPlan === 'Institute') maxAllowedQs = 150;

                if (qCount > maxAllowedQs) throw new Error(`Plan Limit Exceeded! Your current plan (${userPlan}) allows a maximum of ${maxAllowedQs} questions per test.`);
                if (currentCredits < requiredCredits) throw new Error(`Insufficient credits! Aapke paas ${currentCredits} credits hain.`);
                
                finalRemainingCredits = currentCredits - requiredCredits;
                transaction.set(userRef, { credits: finalRemainingCredits }, { merge: true });
            });
            creditsDeducted = true;
        }

        const streamContext = stream ? `Stream: ${stream}. ` : "";
        
        // Clean & Centralized Prompt
        const prompt = `You are an elite expert question paper setter.
        YOUR TASK: Generate exactly ${qCount} Multiple Choice Questions (MCQs) for the subject "${subject}", focusing on the topic "${chapter}".
        
        ${buildExamPersona(targetExam, board, streamContext, medium, subject, difficulty || 'medium')}
        ${strictNegativeRules}
        
        Return ONLY a JSON array of objects strictly matching this schema: [ { "question": "Question text", "options": { "A": "Opt1", "B": "Opt2", "C": "Opt3", "D": "Opt4" }, "correctAnswer": "A", "explanation": "Detailed step-by-step mathematical/logical explanation proving why the answer is correct." } ]`;
        
        const parts = [{ text: prompt }];
        const response = await generateAIContent(parts, true);
        const quizArray = safeJSONParse(response.text);

        res.status(200).json({ success: true, quizArray, remainingCredits: finalRemainingCredits });

    } catch (error) {
        console.error("🚨 Custom Generation Error:", error.message || error);
        let errorMessage = "AI Servers are experiencing high demand right now. Your credits have been safely refunded. Please try again in 1 minute.";
        if (error.message === "GUEST_LIMIT_REACHED") errorMessage = "Free trial exhausted for this device/IP. Please log in with Google to continue generating unlimited tests.";
        else if (error.message && (error.message.includes("Plan Limit") || error.message.includes("Insufficient credits"))) errorMessage = error.message;
        else if (error.message && !error.message.includes("ApiError") && !error.message.includes("503") && !error.message.includes("JSON")) errorMessage = error.message; 

        if (userId !== 'guest_user' && creditsDeducted) {
            try {
                const userRef = db.collection('users').doc(userId);
                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    if (userDoc.exists) {
                        let currentCredits = Number(userDoc.data().credits || 0);
                        transaction.set(userRef, { credits: currentCredits + requiredCredits }, { merge: true });
                    }
                });
            } catch (refundErr) {}
        }
        res.status(500).json({ success: false, error: errorMessage });
    }
});
// =======================================================================
// 🔥 2. TEACHER CREATES A GROUP TEST (With Uploads, AI, Refund & SK Code) 🔥
// =======================================================================
app.post('/api/v1/create-class', upload.array('files', 10), async (req, res) => {
    let requiredCredits = 0;
    let creditsDeducted = false;
    const userId = req.user ? req.user.uid : 'guest_user';

    try {
        if (userId === 'guest_user') {
            return res.status(403).json({ success: false, error: "Only logged in teachers can create classes." });
        }

        let config = req.body.config ? JSON.parse(req.body.config) : req.body;
        const { className, duration, expiryHours, requireBatch, mode, questionCount } = config;

        if (!className || !duration || Number(duration) < 5) {
            return res.status(400).json({ success: false, error: "Invalid class details." });
        }
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: "Please upload test paper / answer key files." });
        }

        const qCount = Number(questionCount) || 15;
        requiredCredits = Math.max(5, Math.ceil(qCount * 0.5));
        
        // 💰 1. DEDUCT CREDITS FIRST
        const userRef = db.collection('users').doc(userId);
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            let currentCredits = 30; 
            if (userDoc.exists && userDoc.data().credits !== undefined) {
                currentCredits = Number(userDoc.data().credits);
            }
            if (currentCredits < requiredCredits) throw new Error(`Insufficient credits! You need ${requiredCredits} to generate this group test.`);
            transaction.set(userRef, { credits: currentCredits - requiredCredits }, { merge: true });
        });
        creditsDeducted = true; // Mark as deducted so we can refund if AI fails

        // 🧠 2. GENERATE PROMPT
        let prompt = "";
        if (mode === 'manual-key') {
            prompt = `You are a strict data extraction bot. The attached files contain a Question Paper and an Answer Key. 
            CRITICAL INSTRUCTION: You MUST extract exactly ${qCount} questions from the paper, and you MUST assign the correct answer EXACTLY as provided in the uploaded Answer Key. 
            DO NOT use your own AI knowledge to solve the questions. ONLY follow the teacher's uploaded answer key. If an explanation is missing, write "Answer per official key."
            WARNING: DO NOT use markdown formatting inside JSON. 
            Return ONLY a raw JSON array: [ { "question": "Q", "options": { "A": "1", "B": "2", "C": "3", "D": "4" }, "correctAnswer": "A", "explanation": "Exp" } ]`;
        } else {
            prompt = `You are an expert academic examiner. Analyze the attached study notes/files. 
            Generate exactly ${qCount} multiple choice questions (MCQs) STRICTLY based on this content. 
            ${strictNegativeRules}
            Return ONLY a raw JSON array: [ { "question": "Q", "options": { "A": "1", "B": "2", "C": "3", "D": "4" }, "correctAnswer": "A", "explanation": "Exp" } ]`;
        }

        const parts = [{ text: prompt }];
        let totalSize = 0;
        req.files.forEach(file => { 
            totalSize += file.size;
            parts.push({ inlineData: { data: file.buffer.toString("base64"), mimeType: file.mimetype } }); 
        });

        if (totalSize > 8 * 1024 * 1024) {
            throw new Error("Uploaded files are too large for AI processing. Please upload compressed PDFs or fewer images (Max 8MB total).");
        }

        // 🤖 3. CALL AI
        const response = await generateAIContent(parts, true);
        const quizArray = safeJSONParse(response.text);

        // 🎟️ 4. GENERATE "SK" CODE (No Hyphens, Starts with SK, Pure Alphanumeric)
        const safeName = xss(className).trim();
        const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 random chars
        const generatedCode = `SK${randomHex}`; // Output e.g., SK8B2F9A
        
        const expiresAt = Date.now() + (Number(expiryHours) * 60 * 60 * 1000);

        // 💾 5. SAVE TO DATABASE
        await db.collection('LiveExams').doc(generatedCode).set({
            code: generatedCode,
            name: safeName,
            instructorUid: req.user.uid,
            instructorEmail: req.user.email,
            instructorName: req.user.name,
            duration: Number(duration),
            requireBatch: Boolean(requireBatch),
            expiresAt: expiresAt,
            quizData: quizArray, 
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'active'
        });

        res.status(200).json({ success: true, code: generatedCode, expiresAt });

    } catch (error) {
        console.error("🚨 Class Creation Error:", error);

        // ♻️ AUTO-REFUND MECHANIC (Only refund if credits were actually deducted)
        if (creditsDeducted) {
            try {
                const userRef = db.collection('users').doc(userId);
                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    if (userDoc.exists) {
                        let currentCredits = Number(userDoc.data().credits || 0);
                        transaction.set(userRef, { credits: currentCredits + requiredCredits }, { merge: true });
                        console.log(`♻️ Auto-refunded ${requiredCredits} credits to teacher ${userId}`);
                    }
                });
            } catch (refundErr) {
                console.error("🚨 Refund Transaction Failed:", refundErr);
            }
        }

        res.status(500).json({ success: false, error: error.message || "Failed to generate class. Check files." });
    }
});
// =======================================================================
// 🔥 3. STUDENT JOINS A CLASS (Verify Code) 🔥
// =======================================================================
app.post('/api/v1/verify-class', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ success: false, error: "Access code is required." });

        const safeCode = xss(code.trim().toUpperCase());
        const docRef = await db.collection('LiveExams').doc(safeCode).get();

        if (!docRef.exists) return res.status(404).json({ success: false, error: "Invalid Code. Check with your teacher." });

        const group = docRef.data();

        if (Date.now() > group.expiresAt) {
            return res.status(403).json({ success: false, error: `CODE EXPIRED! This test was valid until ${new Date(group.expiresAt).toLocaleString()}` });
        }

        res.status(200).json({ 
            success: true, 
            group: {
                code: group.code,
                name: group.name,
                instructorEmail: group.instructorEmail,
                duration: group.duration,
                requireBatch: group.requireBatch,
                quizData: group.quizData 
            }
        });

    } catch (error) {
        console.error("🚨 Class Verification Error:", error);
        res.status(500).json({ success: false, error: "Network error checking code." });
    }
});

// =======================================================================
// 🔥 4. SAVE EXAM HISTORY & SEGREGATION 🔥
// =======================================================================
app.post('/api/v1/save-history', async (req, res) => {
    try {
        const { subject, score, total, quizData, userAnswers, flaggedQuestions, testType, groupCode, candidateDetails } = req.body;
        const activeUserId = req.user ? req.user.uid : 'guest_user';
        
        const docRef = await db.collection('history').add({
            userId: xss(activeUserId),
            subject: xss(subject || 'General'),
            score: Number(score) || 0,
            total: Number(total) || 0,
            testType: xss(testType || 'individual'), 
            groupCode: xss(groupCode || 'none'),     
            candidateDetails: candidateDetails || null, 
            quizData,
            userAnswers: userAnswers || {},
            flaggedQuestions: flaggedQuestions || [],
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ success: true, recordId: docRef.id });
    } catch (error) {
        console.error("🚨 Firestore History Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =======================================================================
// 🔥 5. TEACHER ANALYTICS DASHBOARD (SECURE FETCH WITH DETAILS) 🔥
// =======================================================================
app.get('/api/v1/class-analytics/:code', async (req, res) => {
    try {
        if (!req.user || req.user.uid === 'guest_user') return res.status(403).json({ success: false, error: "Unauthorized." });

        const classCode = xss(req.params.code.trim().toUpperCase());
        const classDoc = await db.collection('LiveExams').doc(classCode).get();
        if (!classDoc.exists) return res.status(404).json({ success: false, error: "Class code not found." });
        
        const classData = classDoc.data();
        if (classData.instructorUid !== req.user.uid) return res.status(403).json({ success: false, error: "Access Denied." });

        const historySnapshot = await db.collection('history').where('groupCode', '==', classCode).get();
        
        let studentResults = [];
        let totalScoreSum = 0;

        historySnapshot.forEach(doc => {
            const data = doc.data();
            totalScoreSum += data.score;
            studentResults.push({
                name: data.candidateDetails?.name || "Unknown",
                rollNo: data.candidateDetails?.rollNo || "N/A",
                batch: data.candidateDetails?.batchTime || "N/A",
                score: data.score,
                timeTaken: data.time || "Unknown",
                submittedAt: data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().toISOString() : data.createdAt) : null,
                userAnswers: data.userAnswers
            });
        });

        res.status(200).json({
            success: true,
            analytics: {
                className: classData.name,
                totalStudents: studentResults.length,
                averagePercentage: classData.quizData.length > 0 ? ((studentResults.length > 0 ? (totalScoreSum / studentResults.length) : 0) / classData.quizData.length * 100).toFixed(1) : 0,
                maxScore: classData.quizData.length,
                quizData: classData.quizData, 
                students: studentResults
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: "Server error." });
    }
});
// =======================================================================
// 🔥 6. STUDENT LEADERBOARD (TOP 10 + USER RANK) 🔥
// =======================================================================
app.get('/api/v1/leaderboard/:code', async (req, res) => {
    try {
        const classCode = xss(req.params.code.trim().toUpperCase());
        const studentName = req.query.name ? xss(req.query.name.trim()) : null; 

        const classDoc = await db.collection('LiveExams').doc(classCode).get();
        if (!classDoc.exists) return res.status(404).json({ success: false, error: "Class not found." });

        const historySnapshot = await db.collection('history').where('groupCode', '==', classCode).get();
        let students = [];
        
        historySnapshot.forEach(doc => {
            students.push({ name: doc.data().candidateDetails?.name || "Student", score: doc.data().score });
        });

        // Sort Highest to Lowest
        students.sort((a, b) => b.score - a.score);

        let rankedStudents = [];
        let currentRank = 1;
        let currentUserRankData = null;

        for(let i = 0; i < students.length; i++) {
            if (i > 0 && students[i].score < students[i-1].score) currentRank = i + 1;
            
            const rankObj = { rank: currentRank, name: students[i].name, score: students[i].score };
            rankedStudents.push(rankObj);

            // Save rank if it matches the student requesting it
            if (studentName && students[i].name.toLowerCase() === studentName.toLowerCase()) {
                if (!currentUserRankData) currentUserRankData = rankObj;
            }
        }

        res.status(200).json({
            success: true,
            maxScore: classDoc.data().quizData.length,
            top10: rankedStudents.slice(0, 10), 
            userRank: currentUserRankData 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: "Leaderboard error" });
    }
});
// =======================================================================
// 🔥 7. RAZORPAY ORDER CREATION (SMART BUSINESS TRACKING) 🔥
// =======================================================================
app.post('/api/v1/create-order', async (req, res) => {
    try {
        if (!req.user || req.user.uid === 'guest_user') return res.status(403).json({ success: false, error: "Please log in to purchase credits." });
        
        const { amount } = req.body;
        if (!amount || amount < 1) return res.status(400).json({ success: false, error: "Invalid amount." });

        const options = {
            amount: amount * 100, 
            currency: "INR",
            // Prefix added for easy tracking in Razorpay Dashboard
            receipt: `QUIZ_${req.user.uid.substring(0, 5)}_${Date.now()}`,
            // Custom notes to separate Quiz money from DDH ecommerce money
            notes: {
                business: "NotesToQuiz",
                userEmail: req.user.email
            }
        };
        
        const order = await razorpay.orders.create(options);
        res.status(200).json({ success: true, order });
    } catch (error) {
        console.error("Razorpay Order Error:", error);
        res.status(500).json({ success: false, error: "Failed to connect to payment gateway." });
    }
});

// =======================================================================
// 🔥 8. RAZORPAY PAYMENT VERIFICATION & PLAN UPGRADE 🔥
// =======================================================================
app.post('/api/v1/verify-payment', async (req, res) => {
    try {
        if (!req.user || req.user.uid === 'guest_user') return res.status(403).json({ success: false, error: "Unauthorized." });
        
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, creditsToAdd } = req.body;

        const generated_signature = crypto.createHmac('sha256', process.env.RAZORPAY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest('hex');

        if (generated_signature !== razorpay_signature) {
            return res.status(400).json({ success: false, error: "Payment verification failed. Signature mismatch." });
        }

        // 🔥 DYNAMIC PLAN UPGRADE MAPPING 🔥
        let upgradedPlan = 'Starter';
        const added = Number(creditsToAdd);
        if (added >= 300 && added < 750) upgradedPlan = 'Pro';
        else if (added >= 750 && added < 2000) upgradedPlan = 'Elite';
        else if (added >= 2000) upgradedPlan = 'Institute';

        const userRef = db.collection('users').doc(req.user.uid);
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            let currentCredits = 0;
            if (userDoc.exists && userDoc.data().credits !== undefined) {
                currentCredits = Number(userDoc.data().credits);
            }
            
            transaction.set(userRef, { 
                credits: currentCredits + added,
                plan: upgradedPlan // 🔥 Saves the new plan to DB
            }, { merge: true });
        });

        res.status(200).json({ success: true, message: `Payment verified. Upgraded to ${upgradedPlan} Plan!` });
    } catch (error) {
        console.error("Payment Verification Error:", error);
        res.status(500).json({ success: false, error: "Failed to verify payment." });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Production Server running on port ${PORT}`);
});
