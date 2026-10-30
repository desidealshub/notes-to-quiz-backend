const xss = require('xss');
const crypto = require('crypto');
const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
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

// 🔥 NODEMAILER SETUP (BULLETPROOF CONFIGURATION) 🔥
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // SSL encryption
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS // 16-character App Password expected here
    }
});

// Configure multer for memory storage (Max 10MB per file)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// ==========================================
// --- SECURITY & MIDDLEWARE CONFIGURATION ---
// ==========================================

app.use(helmet());

// 🔥 1. STRICT CORS POLICY
const allowedOrigins = [
    'https://notestoquiz.in', 
    'https://www.notestoquiz.in',
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
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 500, 
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

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummykey',
    key_secret: process.env.RAZORPAY_SECRET || 'dummysecret'
});

// 🔥 GEMINI AI SDK SETUP (MULTI-KEY FALLBACK) 🔥
const { GoogleGenAI } = require('@google/genai');
const rawKeys = process.env.GEMINI_API_KEY || 'dummykey';
const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(k => k);
const aiClients = apiKeys.map(key => new GoogleGenAI({ apiKey: key }));
let currentClientIndex = 0;

// Master AI Generation Function (Now Smart & Flexible)
async function generateAIContent(parts, isJsonMode = false) {
    let attempts = 0;
    const maxRetries = 3;
    let lastError;

    while (attempts < maxRetries) {
        try {
            const ai = aiClients[currentClientIndex];
            
            // Setting config dynamically based on what the route needs
            const configParams = {};
            if (isJsonMode) {
                configParams.responseMimeType = "application/json";
            }

            const response = await ai.models.generateContent({
                model: 'gemini-3.6-flash',
                contents: parts,
                config: configParams
            });
            
            return response;
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ Gemini Key ${currentClientIndex + 1} failed (Status:${err.status || 'Unknown'}). Retrying...`);
            
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
const verifyAuthToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
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

    // 🚨 1. EXAM & SUBJECT SPECIFIC TONE (EXTREME STRICTNESS) 🚨
    if (target === 'jee_adv') {
        examStyle = `🚨 JEE ADVANCED MODE (EXTREME DIFFICULTY): Generate exceptionally complex, multi-layered questions. 
        - You MUST intertwine 2-3 advanced concepts from different chapters in a single question. 
        - Include a mix of Single Choice (type: "single"), Multiple Correct (type: "multiple"), and Integer Type (type: "integer").
        - Force the student to perform heavy derivations, rigorous mathematical steps, and solve for hidden variables. DO NOT ask direct formula-based questions. Options should be abstract expressions.`;
    } else if (target === 'jee_mains') {
        examStyle = `🚨 JEE MAINS MODE: Generate tricky, speed-breaker numericals mirroring NTA 2024 patterns. 
        - Include a mix of Single Choice (type: "single") and Integer Type (type: "integer") questions.
        - Focus on calculation traps, edge cases in formulas, and algebraic manipulations.`;
    } else if (target === 'neet') {
        if (sub.includes('physics')) {
            examStyle = `🚨 NEET PHYSICS MODE: Focus on conceptual traps and speed. Use assertion-reasoning or statement-based questions. Type must be "single".`;
        } else if (sub.includes('biology') || sub.includes('botany') || sub.includes('zoology')) {
            examStyle = `🚨 NEET BIOLOGY MODE: Focus on deep NCERT line-by-line factual recall, matching lists, and assertion-reasoning. Type must be "single".`;
        } else {
            examStyle = `🚨 NEET MODE: Focus on speed, factual accuracy, and direct conceptual application mirroring NTA patterns. Type must be "single".`;
        }
        } else if (target === 'ssc' || target === 'banking' || target === 'railway' || target === 'bihar_police') {
        let quantOverride = "";
        if (sub.includes('math') || sub.includes('aptitude') || sub.includes('quant')) {
            quantOverride = `\n⚠️ QUANTITATIVE APTITUDE LATEX OVERRIDE: Write simple numbers, percentages (e.g., 20%), currency (₹500), and ratios (3:4) as PLAIN TEXT. DO NOT wrap them in '$'. ONLY use '$...$' for actual algebra, variables, or complex fractions. NEVER use '&' or '{}' in plain text.`;
        }
        examStyle = `🚨 COMPETITIVE EXAM MODE: Focus on tricky distractors, arithmetic shortcuts, logic puzzles, or highly specific GK facts. Type must be "single".` + quantOverride;
    } else if (target === 'class12' || target === 'class10') {
        examStyle = `🚨 BOARD EXAM MODE (${board || 'CBSE'}): Mirror the exact pattern of board exams. Use case-study based questions and standard conceptual proofs. Type must be "single".`;
    } else {
        examStyle = `🚨 COMPETITIVE MODE: Adapt strictly to the ${academicLevel} standard for${subject}.`;
    }
    // 👇🔥 यहाँ पर तेरा MISCELLANEOUS वाला लॉजिक आएगा 🔥👇
    if (sub.includes('miscellaneous') || sub.includes('mix')) {
        examStyle += `\n🔥 MISCELLANEOUS / FULL MOCK MODE: Mix questions from completely different chapters and topics of the syllabus unpredictably. Test the student's ability to switch concepts quickly. Strict adherence to the requested difficulty level.`;
    }
    // 🚨 2. DIFFICULTY SCALING 🚨
    let diffRules = "";
    if (difficulty.toLowerCase() === 'hard') {
        diffRules = `🔥 DIFFICULTY: HARD. DO NOT ask single-step questions. Make the scenario complex. Hide direct data and make the student derive it first.`;
    } else {
        diffRules = `Difficulty: ${difficulty}. Standard previous year question level.`;
    }

    // 🚨 3. LANGUAGE INSTRUCTION 🚨
    let mediumText = "";
    if (sub.includes("english") || medium === "English") {
        mediumText = "CRITICAL LANGUAGE RULE: Entire output MUST be in PROFESSIONAL ENGLISH.";
    } else if (medium === "Hindi") {
        mediumText = "CRITICAL LANGUAGE RULE: Questions, options, and explanations MUST be entirely in PURE HINDI (Devanagari). However, strictly retain all technical Math/Science formulas in English LaTeX enclosed in '$'. DO NOT translate math variables to Hindi.";
    }

    // 🔥 100% BULLETPROOF STRING FIX (No || operators inside template string)
    const finalTarget = academicLevel ? academicLevel : 'Competitive Test';
    const finalSub = subject ? subject : 'General';
    return `Target Exam: ${finalTarget} - Subject: ${finalSub}\n${examStyle}\n${diffRules}\n${mediumText}`;
}

const strictNegativeRules = `
⚠️ STRICT NEGATIVE RULES & QUALITY ASSURANCE:
1. 🎯 100% FACTUAL ACCURACY: The 'correctAnswer' MUST be indisputably correct.
2. 🧮 SMART FORMATTING: Use standard LaTeX enclosed in SINGLE '$' signs for ALL equations, variables, and fractions (e.g., $\\frac{1}{2}$). 
3. 🚨 CRITICAL FOR OPTIONS: Any fraction, equation, or math variable inside the options (A, B, C, D) MUST ALWAYS be wrapped in '$' signs.
4. ⚡ EXPLANATION RULES (COACHING STYLE): You are a friendly Indian coaching teacher, NOT a textbook. STRICT LANGUAGE MATCHING: The explanation MUST strictly be in the SAME language as the generated question (e.g., if the question is in Hindi, explain in simple Hindi. If English, explain in simple English). Keep it extremely simple, use maximum 2 to 3 very short bullet points. Do NOT use complex vocabulary. If there is a 'Short-Trick' or 'Logic', explain that directly. Make it so easy that a 10th-grade average student can understand it in 5 seconds. Use the exact HTML tag <br><br> for line breaks.
5. ❌ NO MARKDOWN IN TEXT: NEVER use asterisks (**) or underscores (__) for bolding.
6. 🔢 INTEGER QUESTIONS: If type is "integer", the 'correctAnswer' MUST be a strict whole number string (e.g., "4", "45") using ONLY numerical digits (0-9). DO NOT include signs, decimals, variables, or words.
7. 📊 MATCH THE COLUMNS: If a question is "Match the following", you MUST format Column I and Column II strictly SIDE-BY-SIDE using an HTML table inside the 'question' field like this: <table style='width:100%; border-collapse:collapse; margin-top:10px; font-size:0.9em;'><tr style='border-bottom:1px solid #cbd5e1; text-align:left;'><th style='padding:6px;'>Column I</th><th style='padding:6px;'>Column II</th></tr><tr><td style='padding:6px; vertical-align:top;'>(A) Item 1</td><td style='padding:6px; vertical-align:top;'>(P) Match 1</td></tr></table>. Use ONLY single quotes (') inside HTML attributes so JSON never breaks. NEVER stack the two columns one below the other.
8. 🚨 CRITICAL JSON RULE: Return PURE JSON ARRAY ONLY. NO markdown tags like \`\`\`json. NO introductory or closing text. Start exactly with '[' and end with ']'.`;
9. You MUST explain the correct answer in a detailed, step-by-step format. Use HTML tags for formatting: use <b> for bold, <br> for line breaks, and <ul><li> for bullet points. NEVER output the explanation as a single continuous paragraph. Break it down logically.
    
// 🔥 THE ULTIMATE JSON PARSER (FIXES ALL MARKDOWN BUGS)
function safeJSONParse(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        try {
            // Aggressively strip Markdown and any text outside the JSON array
            let cleanStr = str.replace(/```json/gi, '').replace(/```/gi, '').trim();
            const firstBracket = cleanStr.indexOf('[');
            const lastBracket = cleanStr.lastIndexOf(']');
            if (firstBracket !== -1 && lastBracket !== -1) {
                cleanStr = cleanStr.substring(firstBracket, lastBracket + 1);
            }
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

// 🔥 WAKE UP ROUTE
app.get('/api/ping', (req, res) => {
    res.status(200).send('PONG - Server is awake!');
});

// =======================================================================
// 🔥 HACK-PROOF & SEQUENTIAL SUPPORT TICKET SYSTEM 🔥
// =======================================================================

app.post('/api/v1/support-ticket', async (req, res) => {
    try {
        const { issueType, description, timestamp } = req.body;
        let activeUserId = 'guest_user';
        let activeUserEmail = 'guest@notestoquiz.in';
        let activeUserName = 'Guest';

        // 🚨 HACK-PROOF SECURITY: Token Verification
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const idToken = authHeader.split('Bearer ')[1];
            try {
                const decodedToken = await admin.auth().verifyIdToken(idToken);
                activeUserId = decodedToken.uid;
                activeUserEmail = decodedToken.email || 'No Email';
                activeUserName = decodedToken.name || 'Student';
            } catch (verifyErr) {
                console.error("🚨 Token verification failed (Guest mode fallback):", verifyErr.message);
            }
        }

        const safeIssue = xss(String(issueType || 'General'));
        const safeDesc = xss(String(description || ''));

        // 🔥 THE MASTERSTROKE: SEQUENTIAL TICKET ID 🔥
        const customTicketId = `TKT-${Date.now()}`;

        // Save the ticket using .doc().set() so it stays perfectly sequential in DB
        await db.collection('SupportTickets').doc(customTicketId).set({
            ticketId: customTicketId, 
            uid: activeUserId,
            email: activeUserEmail,
            name: activeUserName,
            issueType: safeIssue,
            description: safeDesc,
            status: 'Open', 
            userReportedTime: timestamp || Date.now(),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Shoot Email Notification
        try {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_USER,
                subject: `🚨 New Support Ticket [${customTicketId}]: ${safeIssue}`,
                text: `New Ticket Details:\n\nTicket ID: ${customTicketId}\nName: ${activeUserName}\nEmail: ${activeUserEmail}\nIssue Type: ${safeIssue}\n\nDescription:\n${safeDesc}`
            };
            await transporter.sendMail(mailOptions);
            return res.status(200).json({ success: true, message: 'Ticket received securely and email sent.' });
        } catch (emailError) {
            console.error("🚨 Email sending failed, but ticket saved to DB:", emailError.message);
            return res.status(200).json({ success: true, message: 'Ticket received securely (Email notification delayed).' });
        }
    } catch (error) {
        console.error("Support Ticket Error:", error);
        res.status(500).json({ success: false, error: "Could not save the ticket." });
    }
});

// 🔥 FETCH PREVIOUS SUPPORT TICKETS (HACK-PROOF) 🔥
app.get('/api/v1/my-tickets', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(200).json({ success: true, tickets: [] });
        }

        // Token verify karke asli UID nikalo
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // 🚨 100% SECURE: Sirf usi UID ki tickets nikalo jo token se verify hui hai
        const snapshot = await db.collection('SupportTickets')
            .where('uid', '==', uid)
            .orderBy('createdAt', 'desc')
            .limit(10)
            .get();

        let myTickets = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            const createdMs = d.createdAt && d.createdAt.toDate ? d.createdAt.toDate().getTime() : Date.now();
            myTickets.push({
                id: doc.id,
                issueType: d.issueType,
                description: d.description,
                status: d.status || 'Open',
                date: new Date(createdMs).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
            });
        });

        res.status(200).json({ success: true, tickets: myTickets });
    } catch (error) {
        console.error("🚨 Fetch Tickets Error:", error);
        res.status(500).json({ success: false, error: "Failed to fetch tickets. Invalid Session." });
    }
});

// 🔥 "CHAT WITH SOLUTION" (AI TUTOR FEATURE)
app.post('/api/v1/chat-tutor', async (req, res) => {
    try {
        const { question, options, correctAnswer, explanation, studentDoubt } = req.body;
        
        const prompt = `You are a highly intelligent, patient, and friendly AI Tutor. A student is asking a doubt about a mock test question they just attempted.
        
        [CONTEXT]
        Original Question: ${question}
        Options Provided: ${JSON.stringify(options)}
        Correct Answer: ${correctAnswer}
        Original Explanation: ${explanation}
        Student's Specific Doubt: ${studentDoubt}

        [YOUR TASK & STRICT RULES]
        1. STRICT LANGUAGE MATCHING: Analyze the language and script of the "Original Question". You MUST write your ENTIRE reply in that EXACT SAME language. For example, if the question is in Hindi (Devanagari script), you MUST reply in pure Hindi (Devanagari). The ONLY exception is if the student explicitly asks you to explain in English/Hindi inside their "Student's Doubt".
        2. EXPLAIN LIKE I'M AN 8TH GRADER: The student is confused. Break down the concept into the absolute simplest terms. Explain it as if you are teaching an 8th-class student. Use simple daily-life examples, analogies, and avoid heavy academic jargon.
        3. BE DIRECT & DETAILED: Do not just copy-paste the "Original Explanation". Understand what exactly the student is asking in their doubt, and clear it up step-by-step.
        4. WARM TONE: Start with an encouraging and positive opening.
        5. NO MARKDOWN: NEVER use asterisks (**) or underscores (__) for bolding. If you need to emphasize, use standard HTML <b>tags</b>.
        6. NO ASCII GRAPHS: NEVER try to draw y-axis/x-axis graphs using text characters. It breaks the mobile UI. 
        7. MATH FORMATTING: Wrap all mathematical variables, expressions, and equations in single '$' signs for LaTeX rendering.
        8. EMOJIS & SPACING: Format with bullet points and emojis to make it readable. Use the exact HTML tag <br><br> for line breaks.`;
        
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
        const { subject, questionCount, academicLevel, difficulty } = config;
        
        let qCount = Number(questionCount) || 10;
        
        // BACKEND LIMIT ENFORCEMENT
        if (userId === 'guest_user') qCount = Math.min(qCount, 5);

        requiredCredits = Math.max(5, Math.ceil(qCount * 2));
        let finalRemainingCredits = "Skipped (Guest)";

        // 🔥 GUEST LOGIC (IP ADDRESS FINGERPRINTING)
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
        // 🔥 LOGGED IN USER LOGIC (FREE VS PAID)
        else {
            const userRef = db.collection('users').doc(userId);
            await db.runTransaction(async (transaction) => {
                const userDoc = await transaction.get(userRef);
                let currentCredits = 30;
                let userPlan = 'Free';
                let freeNotesAttempts = 0;

                if (userDoc.exists) {
                    if (userDoc.data().credits !== undefined) currentCredits = Number(userDoc.data().credits);
                    if (userDoc.data().plan !== undefined) userPlan = userDoc.data().plan;
                    if (userDoc.data().freeNotesAttempts !== undefined) freeNotesAttempts = Number(userDoc.data().freeNotesAttempts);
                }

                // 🚨 BACKEND ENFORCEMENT: FREE PLAN CAN ONLY UPLOAD 2 TIMES TOTAL
                if (userPlan === 'Free' && currentCredits <= 30) {
                    qCount = Math.min(qCount, 10);
                    if (freeNotesAttempts >= 2) {
                        throw new Error("FREE_UPLOAD_LIMIT_REACHED");
                    }
                    transaction.set(userRef, { freeNotesAttempts: freeNotesAttempts + 1 }, { merge: true });
                }

                let maxAllowedQs = 15; 
                if (userPlan === 'Starter') maxAllowedQs = 30;
                if (userPlan === 'Pro') maxAllowedQs = 50;
                if (userPlan === 'Elite') maxAllowedQs = 100;
                if (userPlan === 'Institute') maxAllowedQs = 150;

                if (qCount > maxAllowedQs) {
                    throw new Error(`Plan Limit Exceeded! Your current plan (${userPlan}) allows a maximum of ${maxAllowedQs} questions per test. Please upgrade.`);
                }

                if (currentCredits < requiredCredits) throw new Error(`Insufficient credits! You need ${requiredCredits} but have ${currentCredits}.`);
                
                finalRemainingCredits = currentCredits - requiredCredits;
                transaction.set(userRef, { credits: finalRemainingCredits }, { merge: true });
            });
            creditsDeducted = true; 
        }

        const finalSubject = (subject && subject.trim() !== "") ? subject : "Auto-Detected";
        
        const prompt = `You are a ruthless and expert academic examiner. Analyze the attached image/file carefully. 
        YOUR TASK: Extract the core TOPICS, FORMULAS, and CONCEPTS from these notes. Then, generate exactly ${qCount} highly rigorous questions testing those specific concepts.
        Subject context: "${finalSubject}"
        
        ${buildExamPersona(academicLevel, null, null, null, finalSubject, difficulty)}
        ${strictNegativeRules}
        
        CRITICAL SCHEMA: Return ONLY a raw JSON array matching this exact structure: 
        [ 
          { 
            "type": "single", // Can be "single", "multiple" (for multiple correct), or "integer".
            "question": "Question text here...", 
            "options": { "A": "1", "B": "2", "C": "3", "D": "4" }, // If type is "integer", leave options as empty object {}
            "correctAnswer": "A", // If type is "multiple", use comma-separated like "A,C". If "integer", use a whole number string like "4" using 0-9 digits only.
            "explanation": "Detailed step-by-step logic<br><br>Next step..." 
          } 
        ]`;
        
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
        const quizArray = safeJSONParse(response.text);

        res.status(200).json({ success: true, quizArray, remainingCredits: finalRemainingCredits });

    } catch (error) {
        console.error("🚨 Individual Generation Error:", error.message);

        let cleanErrorMessage = "Oops! Something went wrong while generating the test. Please try again.";
        
        // 1. BUSINESS LOGIC ERRORS
        if (error.message === "GUEST_LIMIT_REACHED") {
            cleanErrorMessage = "Free trial exhausted for this device/IP. Please log in with Google to continue generating unlimited tests.";
        } else if (error.message === "FREE_UPLOAD_LIMIT_REACHED") {
            cleanErrorMessage = "Upload Limit Reached. You have used your 2 free Scan-to-Notes uploads. Upgrade your plan to continue uploading notes!";
        } else if (error.message.includes("Plan Limit") || error.message.includes("Insufficient credits") || error.message.includes("large")) {
            cleanErrorMessage = error.message; 
        } 
        // 2. GOOGLE AI API ERRORS
        else if (error.message.includes("Quota exceeded") || error.message.includes("429")) {
            cleanErrorMessage = "Server is currently busy with high traffic. Please wait 1 minute and click generate again.";
        } else if (error.message.includes("503") || error.message.includes("overloaded")) {
            cleanErrorMessage = "The AI engine is temporarily overloaded. Please try again in 10 seconds.";
        } else if (error.message.includes("JSON") || error.message.includes("parse")) {
            cleanErrorMessage = "There was a formatting issue with the generated questions. Please regenerate.";
        } else if (error.message.includes("Safety") || error.message.includes("blocked")) {
            cleanErrorMessage = "Your notes contain restricted or unclear content. Please upload a clearer document.";
        }

        // AUTO-REFUND MECHANIC
        if (userId !== 'guest_user' && creditsDeducted) {
            try {
                const userRef = db.collection('users').doc(userId);
                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    if (userDoc.exists) {
                        let currentCredits = Number(userDoc.data().credits || 0);
                        let freeNotesAttempts = Number(userDoc.data().freeNotesAttempts || 0);
                        let updates = { credits: currentCredits + requiredCredits };
                        if (userDoc.data().plan === 'Free' && freeNotesAttempts > 0) {
                            updates.freeNotesAttempts = freeNotesAttempts - 1;
                        }
                        transaction.set(userRef, updates, { merge: true });
                        console.log(`♻️ Auto-refunded ${requiredCredits} credits to user ${userId}`);
                    }
                });
            } catch (refundErr) {
                console.error("🚨 Refund Transaction Failed:", refundErr);
            }
        }

        res.status(500).json({ success: false, error: cleanErrorMessage });
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
        let qCount = Number(questionCount) || 10;

        // BACKEND LIMIT ENFORCEMENT
        if (userId === 'guest_user') qCount = Math.min(qCount, 10);
        
        if (!medium && (board === 'Bihar Board' || board === 'BSEB (Bihar Board)' || targetExam === 'Bihar Board')) {
            medium = 'Hindi'; 
        }

        requiredCredits = Math.max(5, Math.ceil(qCount * 1)); 
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

                // BACKEND ENFORCEMENT: FREE PLAN LIMIT
                if (userPlan === 'Free' && currentCredits <= 30) {
                    qCount = Math.min(qCount, 15);
                }

                let maxAllowedQs = 15; 
                if (userPlan === 'Starter') maxAllowedQs = 30;
                if (userPlan === 'Pro') maxAllowedQs = 50;
                if (userPlan === 'Elite') maxAllowedQs = 100;
                if (userPlan === 'Institute') maxAllowedQs = 150;

                if (qCount > maxAllowedQs) throw new Error(`Plan Limit Exceeded! Your current plan (${userPlan}) allows a maximum of ${maxAllowedQs} questions per test. Please upgrade.`);
                if (currentCredits < requiredCredits) throw new Error(`Insufficient credits! Aapke paas ${currentCredits} credits hain.`);
                
                finalRemainingCredits = currentCredits - requiredCredits;
                transaction.set(userRef, { credits: finalRemainingCredits }, { merge: true });
            });
            creditsDeducted = true;
        }

        // 1. FRONTEND SE AAYE HUE DATA KO CAPTURE AUR CLEAN KARO
        const examContext = targetExam ? targetExam.toUpperCase() : "Competitive Exam";
        const boardContext = board ? `for ${board} Board` : "";
        const streamContext = stream ? `(${stream} stream)` : "";
        const difficultyLevel = difficulty || 'medium';

        // 🔥 THE FIX: STRICT LANGUAGE ENFORCEMENT 🔥
        let languageInstruction = medium ? `The questions and explanations MUST be written strictly in ${medium} language.` : `The questions and explanations MUST be written in the appropriate language.`;
        
        // Agar subject Hindi ya Sanskrit hai, to WhatsApp language block karo aur pure Devanagari force karo
        if (subject && (subject.toLowerCase().includes('hindi') || subject.toLowerCase().includes('sanskrit') || subject.includes('हिंदी') || subject.includes('संस्कृत'))) {
            languageInstruction = `CRITICAL LANGUAGE RULE: Since the subject is "${subject}", EVERY single word of the questions, options, and explanations MUST be written STRICTLY in pure Devanagari script (Hindi/Sanskrit font). ABSOLUTELY NO Roman English, NO Hinglish, and NO WhatsApp language.`;
        }

        // 2. THE ULTIMATE DYNAMIC AI PROMPT
        const prompt = `You are an elite, highly experienced examiner and paper setter strictly for ${examContext} ${boardContext}.
        
        YOUR TASK: Generate exactly ${qCount} high-quality Multiple Choice Questions (MCQs) or Numerical questions for the subject "${subject}" ${streamContext}, focusing strictly on the topic "${chapter}". 
        
        ${languageInstruction}
        Difficulty Level: ${difficultyLevel}.

        🔥 CRITICAL PYQ INSTRUCTION: 
        Since the target exam is ${examContext}, you MUST prioritize actual Previous Year Questions (PYQs) from real ${examContext} exams (such as BPSC Prelims, NDA (I)/(II), CUET UG, IBPS/SBI PO, SSC CGL, Bihar Daroga, Agniveer, BSEB/CBSE Board, etc.) related to this chapter. 
        If a question is a REAL PYQ, strictly add the exact exam name, shift, and year in the 'pyqTag' field (e.g., 'BPSC 67th PT 2022', 'NDA (I) 2021', 'IBPS PO 2020', 'SSC CGL 2019', 'CUET 2023', 'BSEB 2021'). 
        If it is a newly generated practice question, leave the 'pyqTag' strictly empty ("").

        CRITICAL SCHEMA: Return ONLY a raw JSON array matching this exact structure. DO NOT wrap it in markdown code blocks like \`\`\`json. Return raw JSON only:
        [ 
          { 
            "type": "single",
            "question": "Question text here...", 
            "options": { "A": "Option 1", "B": "Option 2", "C": "Option 3", "D": "Option 4" }, 
            "correctAnswer": "A",
            "explanation": "Detailed step-by-step logic, formula used, or historical fact...",
            "pyqTag": "NDA 2021" 
          } 
        ]`;
        
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
        const { className, duration, expiryHours, requireBatch, requireRoll, requirePhone, mode, questionCount, maxStudents, allowedRolls } = config;
        const capacity = Number(maxStudents) || 50;
        let qCount = Number(questionCount) || 15;

        if (!className || !duration || Number(duration) < 5) {
            return res.status(400).json({ success: false, error: "Invalid class details." });
        }
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: "Please upload test paper / answer key files." });
        }

        // 💰 1. DEDUCT CREDITS & ENFORCE PLAN LIMITS FIRST
        const userRef = db.collection('users').doc(userId);
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            let currentCredits = 30; 
            let userPlan = 'Free';
            
            if (userDoc.exists) {
                if (userDoc.data().credits !== undefined) currentCredits = Number(userDoc.data().credits);
                if (userDoc.data().plan !== undefined) userPlan = userDoc.data().plan;
            }

            // 🔥 GATEKEEPER: ENFORCE QUESTIONS PER TEST BASED ON PLAN
            let maxAllowedQs = 15; // Free Plan default
            if (userPlan === 'Starter') maxAllowedQs = 30;
            if (userPlan === 'Pro') maxAllowedQs = 50;
            if (userPlan === 'Elite') maxAllowedQs = 100;
            if (userPlan === 'Institute') maxAllowedQs = 150;

            if (qCount > maxAllowedQs) {
                throw new Error(`Plan Limit Exceeded! Your current plan (${userPlan}) allows a maximum of ${maxAllowedQs} questions per test. Please upgrade.`);
            }

            requiredCredits = Math.max(20, Math.ceil(qCount * 1));

            if (currentCredits < requiredCredits) {
                throw new Error(`Insufficient credits! You need ${requiredCredits} to generate this group test.`);
            }
            
            transaction.set(userRef, { credits: currentCredits - requiredCredits }, { merge: true });
        });
        creditsDeducted = true; 

        // 🧠 2. GENERATE PROMPT
        let prompt = "";
        if (mode === 'manual-key') {
            prompt = `You are a strict data extraction bot. The attached files contain a Question Paper and an Answer Key. 
            CRITICAL INSTRUCTION: You MUST extract exactly ${qCount} questions from the paper, and you MUST assign the correct answer EXACTLY as provided in the uploaded Answer Key. 
            DO NOT use your own AI knowledge to solve the questions. ONLY follow the teacher's uploaded answer key. If an explanation is missing, write "Answer per official key."
            WARNING: DO NOT use markdown formatting inside JSON. 
            Return ONLY a raw JSON array: [ { "type": "single", "question": "Q", "options": { "A": "1", "B": "2", "C": "3", "D": "4" }, "correctAnswer": "A", "explanation": "Exp" } ]`;
        } else {
            prompt = `You are an expert academic examiner. Analyze the attached study notes/files. 
            Generate exactly ${qCount} multiple choice questions (MCQs) STRICTLY based on this content. 
            ${strictNegativeRules}
            Return ONLY a raw JSON array: [ { "type": "single", "question": "Q", "options": { "A": "1", "B": "2", "C": "3", "D": "4" }, "correctAnswer": "A", "explanation": "Exp" } ]`;
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

        // 🎟️ 4. GENERATE "SK" CODE
        const safeName = xss(className).trim();
        const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase(); 
        const generatedCode = `SK${randomHex}`; 
        
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
            requireRoll: Boolean(requireRoll),
            requirePhone: Boolean(requirePhone),
            maxStudents: capacity,
            expiresAt: expiresAt,
            quizData: quizArray, 
            allowedRolls: allowedRolls || [], // 🔥 THIS IS IMPORTANT FOR ROSTER PROTECTION
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'active'
        });

        res.status(200).json({ success: true, code: generatedCode, expiresAt });

    } catch (error) {
        console.error("🚨 Class Creation Error:", error);

        // ♻️ AUTO-REFUND MECHANIC
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

        // 🛑 2. THE BOUNCER: CHECK MAX CAPACITY 🛑
        const countSnapshot = await db.collection('history').where('groupCode', '==', safeCode).count().get();
        const currentStudentCount = countSnapshot.data().count;

        const MAX_SEATS = group.maxStudents || 50; 
                
        if (currentStudentCount >= MAX_SEATS) {
            return res.status(403).json({ 
                success: false, 
                error: `🚨 CLASS FULL! Maximum ${MAX_SEATS} students allowed. If someone cheated, ask your teacher to remove them first.` 
            });
        }

        res.status(200).json({ 
            success: true, 
            group: {
                code: group.code,
                name: group.name,
                instructorEmail: group.instructorEmail,
                duration: group.duration,
                requireBatch: group.requireBatch,
                requireRoll: group.requireRoll,
                requirePhone: group.requirePhone,
                allowedRolls: group.allowedRolls || [], // 🔥 SENT TO FRONTEND FOR GATEKEEPING
                quizData: group.quizData 
            }
        });

    } catch (error) {
        console.error("🚨 Class Verification Error:", error);
        res.status(500).json({ success: false, error: "Network error checking code." });
    }
});

// =======================================================================
// 🔥 4. SAVE EXAM HISTORY & SEGREGATION (100% ANALYTICS COMPATIBLE) 🔥
// =======================================================================
app.post('/api/v1/save-history', async (req, res) => {
    try {
        const { subject, score, total, time, quizData, userAnswers, flaggedQuestions, testType, groupCode, candidateDetails, isReattempt } = req.body;
        const activeUserId = req.user ? req.user.uid : 'guest_user';
        
        let finalTestType = xss(testType || 'individual');
        let finalGroupCode = xss(groupCode || 'none');

        // 🔥 BACKEND GATEKEEPER: PREVENT FAKE ROLL NUMBERS VIA API HIJACKING 🔥
        if (finalTestType === 'group_test' && finalGroupCode !== 'none') {
            const groupDoc = await db.collection('LiveExams').doc(finalGroupCode).get();
            if (groupDoc.exists) {
                const gData = groupDoc.data();
                if (gData.requireRoll && gData.allowedRolls && gData.allowedRolls.length > 0) {
                    const studentRoll = candidateDetails && candidateDetails.rollNo ? candidateDetails.rollNo.toString().trim() : "";
                    if (!gData.allowedRolls.includes(studentRoll)) {
                        return res.status(403).json({ success: false, error: `Access Denied. Roll Number ${studentRoll} is not enrolled in this batch.` });
                    }
                }
            }

            // 🔥 FIRST ATTEMPT ONLY PROTECTION FOR GROUP TESTS 🔥
            let alreadyAttempted = Boolean(isReattempt);

            if (!alreadyAttempted && activeUserId !== 'guest_user') {
                const existingSnap = await db.collection('history')
                    .where('groupCode', '==', finalGroupCode)
                    .where('userId', '==', activeUserId)
                    .limit(1)
                    .get();

                if (!existingSnap.empty) {
                    alreadyAttempted = true;
                }
            }

            if (alreadyAttempted) {
                finalTestType = 'individual';
                finalGroupCode = `reattempt_${finalGroupCode}`;
                console.log(`🚫 Re-attempt filtered from Teacher Analytics for user: ${activeUserId}`);
            }
        }

        const docRef = await db.collection('history').add({
            userId: xss(activeUserId),
            subject: xss(subject || 'General'),
            score: Number(score) || 0,
            total: Number(total) || 0,
            time: xss(time || '00:00'),
            testType: finalTestType, 
            groupCode: finalGroupCode,     
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
// 🔥 4.B FETCH USER'S CLOUD EXAM HISTORY (MULTI-DEVICE SYNC) 🔥
// =======================================================================
app.get('/api/v1/my-history', async (req, res) => {
    try {
        if (!req.user || req.user.uid === 'guest_user') {
            return res.status(200).json({ success: true, history: [] });
        }

        // यूज़र के UID से उसके सारे दिए हुए टेस्ट क्लाउड से निकालो
        const snapshot = await db.collection('history')
            .where('userId', '==', req.user.uid)
            .limit(100)
            .get();

        let cloudHistory = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            const createdMs = d.createdAt && d.createdAt.toDate ? d.createdAt.toDate().getTime() : Date.now();
            
            cloudHistory.push({
                id: doc.id,
                subject: d.subject || 'Practice Test',
                score: Number(d.score) || 0,
                total: Number(d.total) || (Array.isArray(d.quizData) ? d.quizData.length : 10),
                time: d.time || '00:00',
                testType: d.testType || 'individual',
                groupCode: d.groupCode || 'none',
                date: new Date(createdMs).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
                timestamp: createdMs,
                quizData: d.quizData || [],
                userAnswers: d.userAnswers || {},
                flaggedQuestions: d.flaggedQuestions || []
            });
        });

        // सबसे नए टेस्ट को सबसे ऊपर रखो (Newest First)
        cloudHistory.sort((a, b) => b.timestamp - a.timestamp);

        res.status(200).json({ success: true, history: cloudHistory });
    } catch (error) {
        console.error("🚨 Fetch Cloud History Error:", error);
        res.status(500).json({ success: false, error: "Failed to sync history." });
    }
});

// =======================================================================
// 🔥 5. TEACHER ANALYTICS DASHBOARD (ULTRA-FAST PARALLEL + FIELD SELECT) 🔥
// =======================================================================
app.get('/api/v1/class-analytics/:code', async (req, res) => {
    try {
        if (!req.user || req.user.uid === 'guest_user') {
            return res.status(403).json({ success: false, error: "Unauthorized." });
        }
        
        const classCode = xss(req.params.code.trim().toUpperCase());

        // ⚡ SPEED BOOST 1 & 2: दोनों डेटाबेस कॉल एक साथ (Parallel) चलाओ 
        // और .select() से भारी-भरकम quizData को हर स्टूडेंट की फाइल से डाउनलोड होने से रोको!
        const [classDoc, historySnapshot] = await Promise.all([
            db.collection('LiveExams').doc(classCode).get(),
            db.collection('history')
                .where('groupCode', '==', classCode)
                .select('candidateDetails', 'score', 'time', 'createdAt', 'userAnswers')
                .get()
        ]);

        if (!classDoc.exists) {
            return res.status(404).json({ success: false, error: "Class code not found." });
        }
        
        const classData = classDoc.data();
        if (classData.instructorUid !== req.user.uid) {
            return res.status(403).json({ success: false, error: "Access Denied." });
        }

        let studentResults = [];
        let totalScoreSum = 0;

        historySnapshot.forEach(doc => {
            const data = doc.data();
            const numericScore = Number(data.score) || 0;
            totalScoreSum += numericScore;

            studentResults.push({
                docId: doc.id,
                name: data.candidateDetails?.name || "Unknown",
                rollNo: data.candidateDetails?.rollNo || "N/A",
                batch: data.candidateDetails?.batchTime || "N/A",
                phone: data.candidateDetails?.phone || "N/A",
                score: numericScore,
                timeTaken: data.time || "Unknown",
                submittedAt: data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().toISOString() : data.createdAt) : null,
                userAnswers: data.userAnswers || {}
            });
        });

        const totalQs = Array.isArray(classData.quizData) ? classData.quizData.length : 0;

        res.status(200).json({
            success: true,
            analytics: {
                className: classData.name,
                totalStudents: studentResults.length,
                averagePercentage: totalQs > 0 ? ((studentResults.length > 0 ? (totalScoreSum / studentResults.length) : 0) / totalQs * 100).toFixed(1) : 0,
                maxScore: totalQs,
                quizData: classData.quizData,
                students: studentResults
            }
        });
    } catch (error) {
        console.error("🚨 Analytics Fetch Error:", error);
        res.status(500).json({ success: false, error: "Server error." });
    }
});

// =======================================================================
// 🔥 6. STUDENT LEADERBOARD (SMART DENSE RANKING & AUTO-SYNC) 🔥
// =======================================================================
app.get('/api/v1/leaderboard/:code', async (req, res) => {
    try {
        const classCode = xss(req.params.code.trim().toUpperCase());
        const studentName = req.query.name ? xss(req.query.name.trim()) : null;

        // ⚡ लीडरबोर्ड में सिर्फ नाम और स्कोर चाहिए—पूरा पेपर और जवाब डाउनलोड करना बंद!
        const [classDoc, historySnapshot] = await Promise.all([
            db.collection('LiveExams').doc(classCode).select('quizData').get(),
            db.collection('history')
                .where('groupCode', '==', classCode)
                .select('candidateDetails', 'score')
                .get()
        ]);

        if (!classDoc.exists) {
            return res.status(404).json({ success: false, error: "Class not found." });
        }

        let students = [];
        historySnapshot.forEach(doc => {
            students.push({ 
                name: doc.data().candidateDetails?.name || "Student", 
                score: Number(doc.data().score) || 0 
            });
        });

        // 🔥 SMART DENSE RANKING LOGIC 🔥
        students.sort((a, b) => b.score - a.score);

        let rankedStudents = [];
        let currentRank = 1;
        let previousScore = null;
        let currentUserRankData = null;

        for (let i = 0; i < students.length; i++) {
            // अगर स्कोर पिछले वाले से कम है, तभी रैंक 1 बढ़ाओ (सेम स्कोर = सेम रैंक)
            if (previousScore !== null && students[i].score < previousScore) {
                currentRank++;
            }
            
            const rankObj = { rank: currentRank, name: students[i].name, score: students[i].score };
            rankedStudents.push(rankObj);
            previousScore = students[i].score;

            if (studentName && students[i].name.toLowerCase() === studentName.toLowerCase()) {
                if (!currentUserRankData) currentUserRankData = rankObj;
            }
        }

        // 🔥 सिर्फ Top 10 बच्चों को फ्रंटएंड पर भेजो (ताकि डेटाबेस और नेटवर्क का लोड कम रहे)
        const top10Ranked = rankedStudents.filter(s => s.rank <= 10);
        const totalQs = Array.isArray(classDoc.data().quizData) ? classDoc.data().quizData.length : 0;

        res.status(200).json({
            success: true,
            maxScore: totalQs,
            top10: top10Ranked,
            userRank: currentUserRankData
        });
    } catch (error) {
        console.error("🚨 Leaderboard Error:", error);
        res.status(500).json({ success: false, error: "Leaderboard error" });
    }
});

// =======================================================================
// 🔥 7.A CHECK COUPON (FOR FRONTEND UI) 🔥
// =======================================================================
app.post('/api/v1/check-coupon', async (req, res) => {
    try {
        const { amount, couponCode } = req.body;
        if (!amount || !couponCode) return res.status(400).json({ success: false, error: "Missing details." });

        const safeCode = xss(couponCode.trim().toUpperCase());
        const couponDoc = await db.collection('coupons').doc(safeCode).get();

        if (!couponDoc.exists) {
            return res.status(404).json({ success: false, error: "Invalid Coupon Code." });
        }

        const couponData = couponDoc.data();
        if (!couponData.isActive || !couponData.validFor.includes(Number(amount))) {
            return res.status(400).json({ success: false, error: `This code is not valid for the ₹${amount} plan.` });
        }

        const discountAmount = (Number(amount) * Number(couponData.discountPercent)) / 100;
        const finalAmount = Number(amount) - discountAmount;

        res.status(200).json({ 
            success: true, 
            originalAmount: amount,
            finalAmount: finalAmount, 
            discountPercent: couponData.discountPercent 
        });
    } catch (error) {
        console.error("Coupon Check Error:", error);
        res.status(500).json({ success: false, error: "Server error checking coupon." });
    }
});

// =======================================================================
// 🔥 7.B RAZORPAY ORDER CREATION (SMART BUSINESS TRACKING WITH COUPON) 🔥
// =======================================================================
app.post('/api/v1/create-order', async (req, res) => {
    try {
        if (!req.user || req.user.uid === 'guest_user') return res.status(403).json({ success: false, error: "Please log in to purchase credits." });
        
        const { amount, couponCode } = req.body; // 👈 कूपन कोड फ्रंटएंड से आएगा
        if (!amount || amount < 1) return res.status(400).json({ success: false, error: "Invalid amount." });

        let finalPayableAmount = Number(amount);
        let appliedCoupon = null;

        // 🚨 THE BRAIN: Backend Par Coupon Calculation (Hack-Proof)
        if (couponCode) {
            const safeCode = xss(couponCode.trim().toUpperCase());
            const couponDoc = await db.collection('coupons').doc(safeCode).get();
            
            if (couponDoc.exists && couponDoc.data().isActive && couponDoc.data().validFor.includes(Number(amount))) {
                const discount = (Number(amount) * Number(couponDoc.data().discountPercent)) / 100;
                finalPayableAmount = Number(amount) - discount;
                appliedCoupon = safeCode;
            }
        }

        // Razorpay को सिर्फ डिस्काउंटेड (कटा हुआ) अमाउंट ही भेजेंगे
        const options = {
            amount: Math.round(finalPayableAmount * 100), // Razorpay needs paise
            currency: "INR",
            receipt: `QUIZ_${req.user.uid.substring(0, 5)}_${Date.now()}`,
            notes: {
                business: "NotesToQuiz",
                userEmail: req.user.email,
                originalPlan: amount,
                couponUsed: appliedCoupon || 'NONE' // 👈 Razorpay के डैशबोर्ड में भी दिखेगा
            }
        };
        
        const order = await razorpay.orders.create(options);
        
        // फ्रंटएंड को नया अमाउंट बता दो ताकि Razorpay का पॉपअप उतने का ही खुले
        res.status(200).json({ success: true, order, finalAmount: finalPayableAmount, appliedCoupon });
    } catch (error) {
        console.error("Razorpay Order Error:", error);
        res.status(500).json({ success: false, error: "Failed to connect to payment gateway." });
    }
});

// =======================================================================
// 🔥 8. RAZORPAY PAYMENT VERIFICATION & COMMISSION TRACKING 🔥
// =======================================================================
app.post('/api/v1/verify-payment', async (req, res) => {
    try {
        if (!req.user || req.user.uid === 'guest_user') return res.status(403).json({ success: false, error: "Unauthorized." });
        
        // 🔥 Front-end se 'couponUsed' aur 'amountPaid' bhi aayega
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, creditsToAdd, phone, originalPlanAmount, amountPaid, couponUsed } = req.body;

        const generated_signature = crypto.createHmac('sha256', process.env.RAZORPAY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest('hex');

        if (generated_signature !== razorpay_signature) {
            return res.status(400).json({ success: false, error: "Payment verification failed. Signature mismatch." });
        }

        let upgradedPlan = 'Starter';
        const added = Number(creditsToAdd);
        if (added >= 250 && added < 600) upgradedPlan = 'Pro';
        else if (added >= 600 && added < 2000) upgradedPlan = 'Elite';
        else if (added >= 2000) upgradedPlan = 'Institute';

        const userRef = db.collection('users').doc(req.user.uid);
        const userDoc = await userRef.get();
        const userData = userDoc.data() || {};
        
        let finalCreditsToAdd = added;
        let bonusMessage = "";

        if (userData.hasMadePurchase === false && userData.referredBy) {
            finalCreditsToAdd += 50; 
            bonusMessage = " (+50 Referral Bonus!)";
            try {
                const referrerRef = db.collection('users').doc(userData.referredBy);
                await referrerRef.set({ credits: admin.firestore.FieldValue.increment(100) }, { merge: true });
            } catch (e) { console.error("⚠️ Referrer update failed:", e); }
        }

        // 1. Update Buyer Account
        await userRef.set({
            credits: admin.firestore.FieldValue.increment(finalCreditsToAdd),
            plan: upgradedPlan,
            phone: xss(phone || userData.phone || ''), 
            hasMadePurchase: true, 
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // 🚨 2. TEACHER COMMISSION TRACKING (FIREBASE LOGGING) 🚨
        // Ye tere admin logic ke liye 'successful_payments' collection banayega
        try {
            await db.collection('successful_payments').add({
                uid: req.user.uid,
                email: req.user.email,
                originalPlan: Number(originalPlanAmount) || 0, // ₹199 or ₹499
                amountPaid: Number(amountPaid) || 0,           // ₹159.20 (discounted)
                couponUsed: couponUsed ? xss(couponUsed.toUpperCase()) : 'NONE', // Kis teacher ka code tha?
                razorpay_payment_id: razorpay_payment_id,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`✅ Payment logged for Commission Tracking. Code: ${couponUsed || 'NONE'}`);
        } catch (dbErr) {
            console.error("⚠️ Failed to log payment for commission, but user upgraded successfully.", dbErr);
        }

        res.status(200).json({ 
            success: true, 
            message: `Payment verified! Added ${finalCreditsToAdd} credits${bonusMessage}`,
            newPlan: upgradedPlan
        });

    } catch (error) {
        console.error("🚨 Razorpay Verification Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// =======================================================================
// 🔥 9. KICK STUDENT FROM GROUP TEST (FREE UP SEAT) 🔥
// =======================================================================
app.post('/api/v1/kick-student', async (req, res) => {
    try {
        // 1. Check if the user is a logged-in teacher
        if (!req.user || req.user.uid === 'guest_user') {
            return res.status(403).json({ success: false, error: "Unauthorized. Please log in." });
        }

        const { classCode, studentId } = req.body;
        if (!classCode || !studentId) {
            return res.status(400).json({ success: false, error: "Missing details." });
        }

        const safeCode = xss(classCode.trim().toUpperCase());
        const safeStudentId = xss(studentId.trim());

        // 2. Verify if this teacher actually owns this class
        const classDoc = await db.collection('LiveExams').doc(safeCode).get();
        if (!classDoc.exists || classDoc.data().instructorUid !== req.user.uid) {
            return res.status(403).json({ success: false, error: "Access Denied. You do not own this class." });
        }

        // 3. Find the student's result in the 'history' collection
        const historySnapshot = await db.collection('history')
            .where('groupCode', '==', safeCode)
            .get();

        let docToDelete = null;

        historySnapshot.forEach(doc => {
            const data = doc.data();
            if (doc.id === safeStudentId || data.userId === safeStudentId || (data.candidateDetails && data.candidateDetails.name === safeStudentId)) {
                docToDelete = doc.id;
            }
        });

        if (!docToDelete) {
            return res.status(404).json({ success: false, error: "Student result not found in database." });
        }

        // 4. Delete that student's record permanently (Seat Freed!)
        await db.collection('history').doc(docToDelete).delete();

        res.status(200).json({ success: true, message: "Student kicked successfully. Seat freed." });

    } catch (error) {
        console.error("🚨 Kick Student Error:", error);
        res.status(500).json({ success: false, error: "Server error while removing student." });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Production Server running on port ${PORT}`);
});
