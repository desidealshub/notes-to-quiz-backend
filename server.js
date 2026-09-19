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
                model: 'gemini-3.6-flash',
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
// 🔥 UNIVERSAL PROMPT ENGINEERING (WITH ULTRA-HARDCORE DIFFICULTY INJECTOR) 🔥
// =======================================================================
function buildExamPersona(academicLevel, board = null, stream = null, medium = null, subject = null, difficulty = 'medium') {
    let persona = "";
    let diffRules = "";
    const isMathOrScience = subject && (subject.toLowerCase().includes("math") || subject.toLowerCase().includes("physics") || subject.toLowerCase().includes("chemistry"));

    // 🚨 1. THE DIFFICULTY ENGINE (THE GAME CHANGER) 🚨
    if (difficulty.toLowerCase() === 'hard') {
        diffRules = `🔥 EXTREME DIFFICULTY MODE ACTIVE: 
        - DO NOT ask any single-step or direct formula-based questions. 
        - For Math/Science, you MUST intertwine 2 to 3 distinct concepts in a single question (e.g., mix Matrices with Integration, or Probability with Complex Numbers).
        - Calculations MUST be rigorous, lengthy, and require high analytical thinking.
        - The distractors (incorrect options) MUST represent common student calculation errors or conceptual traps. 
        - If an average 11th-grade student can solve this easily, YOU HAVE FAILED YOUR TASK. Make them sweat.`;
    } else if (difficulty.toLowerCase() === 'easy') {
        diffRules = "Difficulty Standard: Easy (NCERT Level). Focus on direct definitions, basic formulas, and fundamental understanding.";
    } else {
        diffRules = "Difficulty Standard: Medium (Mains Level). Focus on standard application of concepts, moderate calculations, and typical previous year board/Mains questions.";
    }

    // 🚨 2. EXAM TARGET LOGIC 🚨
    if (academicLevel === "class10" || academicLevel === "class12") {
        const levelName = academicLevel === "class10" ? "High School (Class 10th)" : "Senior Secondary (Class 12th)";
        const boardText = board ? ` You are setting an official board paper for the ${board}.` : "";
        const streamText = stream ? ` Stream: ${stream}.` : "";
        persona = `Target: ${levelName}.${boardText}${streamText} ${diffRules}`;
    } 
    else if (academicLevel === "neet") {
        persona = `Target: NEET UG. ${diffRules} Incorporate tricky Assertion-Reasoning, Statement 1/2, and match-the-following types mirroring NTA's toughest sets.`;
    } 
    else if (academicLevel === "jee_mains") {
        persona = `Target: JEE Mains. ${diffRules} Focus on speed-breaker numericals and logical traps based on recent NTA shifts.`;
    } 
    else if (academicLevel === "jee_adv") {
        // OVERRIDE FOR ADVANCED: Hamesha hardcore rahega
        persona = `Target: JEE Advanced. 🚨 ABSOLUTE MAXIMUM DIFFICULTY 🚨. Do not ask NCERT level questions. Every question MUST involve heavy multi-concept integration (e.g., Coordinate Geometry + Calculus). Use multiple edge cases. Options should look similar to confuse the student.`;
    } 
    else if (["SSC", "Banking", "UPSC", "State PCS", "railway", "bihar_police", "iti"].includes(academicLevel)) {
        persona = `Target: ${academicLevel}. ${diffRules} Generate highly confusing logical distractors similar to official tier-1/tier-2 exam levels.`;
    } else {
        persona = `Target: Academic Assessment. ${diffRules}`;
    }

    // 🚨 3. LANGUAGE / MEDIUM INSTRUCTION 🚨
    const isEnglishSubject = subject && subject.toLowerCase().includes("english");
    let mediumText = "";
    if (isEnglishSubject || medium === "English") {
        mediumText = " CRITICAL LANGUAGE RULE: Entire output (questions, options, explanations) MUST be in PROFESSIONAL ENGLISH.";
    } else if (medium === "Hindi") {
        mediumText = " CRITICAL LANGUAGE RULE: The questions, options (A, B, C, D), and explanations MUST be entirely in PURE HINDI (Devanagari script). Only retain technical Math/Science formulas in English LaTeX.";
    }

    return `${persona}\n${mediumText}`;
}
// 🔥 SOLUTION: SPEED OPTIMIZATION (TOKEN REDUCTION) & MATH FORMATTING
// 🔥 SOLUTION: SPEED OPTIMIZATION, IN-DEPTH EXPLANATION & CLEAN LATEX
const strictNegativeRules = `
⚠️ STRICT NEGATIVE RULES & QUALITY ASSURANCE (DO NOT BREAK THESE):
1. 🎯 100% FACTUAL ACCURACY: The 'correctAnswer' MUST be indisputably correct. Do NOT hallucinate.
2. 📅 DEEP DATA & PYQ INTEGRATION: Ask highly specific questions mirroring official exams.
3. 🚫 NO META-QUESTIONS: NEVER reference the notes themselves.
4. 🔥 PLAUSIBLE DISTRACTORS: Incorrect options MUST be common student mistakes.
5. 🧮 MATH FORMATTING (CRITICAL PREVENT CRASH): 
   - You MUST use standard LaTeX enclosed in SINGLE '$' signs for ALL equations, variables, and formulas (e.g., $\\frac{1}{2}$,$\\alpha + \\beta$).     - DO NOT use double '$$' signs. DO NOT wrap equations in markdown backticks.
   - Write NORMAL LaTeX (like \\frac, \\sqrt, \\alpha). Do NOT double-escape backslashes (our system handles JSON escaping automatically). Avoid using single quotes in math (use ^\\prime instead).
6. ⚡ EXPLANATION DEPTH RULE: 
   - Keep options (A, B, C, D) EXTREMELY SHORT AND CRISP.
   - Provide a HIGHLY DETAILED, step-by-step mathematical or logical proof in the 'explanation' field. Write at least 3-4 paragraphs breaking down EVERY single calculation step. DO NOT use markdown code blocks inside the explanation. Just write plain text intertwined with $LaTeX$.
7. WARNING: Return PURE JSON ARRAY ONLY. NO markdown tags like \`\`\`json.
8. 🚨 NO HTML ENTITIES: NEVER use HTML codes like &gt;, &lt;, or &#39;. Always use raw symbols (<, >, ') inside your LaTeX $...$.`;
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

        let errorMessage = "Our AI servers are experiencing high demand right now. Please try again in 1 minute.";
        
        if (error.message === "GUEST_LIMIT_REACHED") {
            errorMessage = "Free trial exhausted for this device/IP. Please log in with Google to continue generating unlimited tests.";
        } else if (error.message.includes("Plan Limit") || error.message.includes("Insufficient credits") || error.message.includes("large")) {
            errorMessage = error.message;
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

        res.status(500).json({ success: false, error: error.message || "Our AI servers are experiencing high demand right now. Your credits have been safely refunded. Please try again in 1 minute." 
        });
    }
});


// ======================================================================= //
// 🔥 1.B CUSTOM TEST GENERATION (NO UPLOADS - RTS STYLE) 🔥 //
// =======================================================================
app.post('/api/v1/generate-custom-test', async (req, res) => {
    // 🔥 Safe extraction of user ID (fallback to guest_user)
    let userId = req.user ? req.user.uid : 'guest_user';
    let requiredCredits = 0;
    let creditsDeducted = false;

    try {
        // 🔥 Sab naye frontend variables yahan safely extract honge
        let { targetExam, subject, chapter, difficulty, questionCount, board, stream, medium } = req.body;
        const qCount = Number(questionCount) || 10;
        
        // 🔥 BHASHA (LANGUAGE) KA PAKKA INTEZAAM 🔥
        // Naye frontend me board exact 'BSEB (Bihar Board)' bhejta hai
        if (!medium && (board === 'Bihar Board' || board === 'BSEB (Bihar Board)' || targetExam === 'Bihar Board')) {
            medium = 'Hindi'; 
        }

        requiredCredits = Math.max(2, Math.ceil(qCount * 0.4)); 
        let finalRemainingCredits = "Skipped (Guest)";

        // 🔥 BULLETPROOF GUEST LOGIC (Same as Notes Upload)
        if (userId === 'guest_user') {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            const ipHash = crypto.createHash('sha256').update(clientIp).digest('hex'); 
            const ipRef = db.collection('GuestLimits').doc(ipHash);
            
            await db.runTransaction(async (transaction) => {
                const ipDoc = await transaction.get(ipRef);
                let attempts = 0;
                if (ipDoc.exists) attempts = ipDoc.data().attempts || 0;
                
                if (attempts >= 2) throw new Error("GUEST_LIMIT_REACHED");
                
                transaction.set(ipRef, { 
                    attempts: attempts + 1, 
                    lastUsed: admin.firestore.FieldValue.serverTimestamp(),
                    ip: clientIp 
                }, { merge: true });
            });
        } 
        // 🔥 LOGGED IN USER LOGIC
        else {
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
                    throw new Error(`Plan Limit Exceeded! Your current plan (${userPlan}) allows a maximum of ${maxAllowedQs} questions per test. Please upgrade to unlock more.`);
                }

                if (currentCredits < requiredCredits) throw new Error(`Insufficient credits! Aapke paas ${currentCredits} credits hain.`);
                
                finalRemainingCredits = currentCredits - requiredCredits;
                transaction.set(userRef, { credits: finalRemainingCredits }, { merge: true });
            });
            creditsDeducted = true;
        }

        const streamContext = stream ? `Stream: ${stream}. ` : "";
        
        // 🔥 1. LANGUAGE ENFORCER 🔥
        let languageRule = "";
        if (medium && medium.toLowerCase() === 'hindi') {
            languageRule = `🚨 CRITICAL LANGUAGE RULE: The ENTIRE response (Questions, Options, and Detailed Explanations) MUST be in PURE HINDI (Devanagari script). 
            HOWEVER, all mathematical symbols, variables, chemical formulas, and equations MUST remain in standard English LaTeX. Do NOT translate technical terms if they sound unnatural.`;
        } else {
            languageRule = "🚨 CRITICAL LANGUAGE RULE: The entire output must be in professional English.";
        }

        // 🔥 2. SUBJECT-SPECIFIC HARDCORE LOGIC 🔥
        let subjectSpecificRules = "";
        const subLower = subject.toLowerCase();
        if (subLower.includes('physics')) {
            subjectSpecificRules = `PHYSICS DIRECTIVE: Intertwine multiple concepts (e.g., Mechanics + Electromagnetism + Thermodynamics). Use non-ideal conditions (variable mass, friction, air resistance). Focus on heavy calculus-based derivations and multi-body systems.`;
        } else if (subLower.includes('chemistry')) {
            subjectSpecificRules = `CHEMISTRY DIRECTIVE: For Organic, require 3-4 step reaction mechanisms testing stereochemistry and major/minor product exceptions. For Physical, mix equilibrium with thermodynamics or kinetics. For Inorganic, focus on deep exceptions, molecular orbital theory, and coordination compounds.`;
        } else if (subLower.includes('math')) {
            subjectSpecificRules = `MATH DIRECTIVE: If Algebra (P&C, Probability, Sequence), use complex constraints, cases, and abstract sets. If Coordinate Geometry (Conics), intertwine locus, tangents, and calculus. Focus on rigorous algebraic manipulation. Avoid simple single-formula questions.`;
        } else {
            subjectSpecificRules = `EXAM DIRECTIVE: Generate highly confusing logical distractors similar to official tier-1 level exams. Focus on tricky edge cases.`;
        }

        // 🔥 3. THE ULTIMATE PROMPT ENGINE 🔥
        const prompt = `You are an elite expert question paper setter for the ${targetExam || 'Competitive'} exam.
        YOUR TASK: Generate exactly ${qCount} Multiple Choice Questions (MCQs) for the subject "${subject}", specifically focusing on the chapter/topic "${chapter}".
        ${streamContext}Difficulty Level: ${difficulty || 'Medium'}.
        
        🚨 CRITICAL DIFFICULTY DIRECTIVES (MUST FOLLOW):
        1. NO DIRECT FORMULAS: Never ask a question that can be solved using a single direct formula.
        2. ${subjectSpecificRules}
        3. PYQ MIMICRY: The structure, length, and trickiness of the questions MUST perfectly mimic the actual ${targetExam} Previous Year Questions (PYQs) from recent years.
        4. TRICKY OPTIONS: The incorrect options (A, B, C, D) MUST represent common student calculation errors, sign mistakes, or conceptual traps.
        
        ${languageRule}
        ${buildExamPersona(targetExam, board, stream, medium, subject, difficulty || 'medium')}
        ${strictNegativeRules}
        
        Return ONLY a JSON array of objects strictly matching this schema: [ { "question": "Question text", "options": { "A": "Opt1", "B": "Opt2", "C": "Opt3", "D": "Opt4" }, "correctAnswer": "A", "explanation": "Detailed step-by-step mathematical/logical explanation proving why the answer is correct." } ]`;
        
        const parts = [{ text: prompt }];
        const response = await generateAIContent(parts, true);
        const quizArray = safeJSONParse(response.text);

        res.status(200).json({ success: true, quizArray, remainingCredits: finalRemainingCredits });

    } catch (error) {
        console.error("🚨 Custom Generation Error:", error.message || error);

        // 🔥 CLEAN ERROR LOGIC (No ugly JSON/503 errors)
        let errorMessage = "AI Servers are experiencing high demand right now. Your credits have been safely refunded. Please try again in 1 minute.";
        
        if (error.message === "GUEST_LIMIT_REACHED") {
            errorMessage = "Free trial exhausted for this device/IP. Please log in with Google to continue generating unlimited tests.";
        } else if (error.message && (error.message.includes("Plan Limit") || error.message.includes("Insufficient credits"))) {
            errorMessage = error.message;
        } else if (error.message && !error.message.includes("ApiError") && !error.message.includes("503") && !error.message.includes("JSON")) {
            errorMessage = error.message; 
        }

        // Auto-Refund Mechanic
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

        res.status(500).json({ success: false, error: errorMessage });
    }
});
// =======================================================================
// 🔥 2. TEACHER CREATES A GROUP TEST (With Uploads & AI) 🔥
// =======================================================================
app.post('/api/v1/create-class', upload.array('files', 10), async (req, res) => {
    try {
        if (!req.user || req.user.uid === 'guest_user') {
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
        const userId = req.user.uid;
        
        const requiredCredits = Math.max(5, Math.ceil(qCount * 0.5));
        
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

        const response = await generateAIContent(parts, true);
        const cleanText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
        const safeJsonText = cleanText.replace(/\\(?!["\\/bfnrt])/g, "\\\\"); 
        const quizArray = JSON.parse(safeJsonText);

        const safeName = xss(className).trim();
        const prefix = safeName.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'ABC').substring(0, 3);
        const randomSuffix = crypto.randomBytes(2).toString('hex').toUpperCase();
        const generatedCode = `${prefix}-${randomSuffix}`;
        
        const expiresAt = Date.now() + (Number(expiryHours) * 60 * 60 * 1000);

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
