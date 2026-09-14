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
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// ==========================================
// --- SECURITY & MIDDLEWARE CONFIGURATION ---
// ==========================================

app.use(helmet());

// 🔥 1. STRICT CORS POLICY (Hackers block karne ke liye)
const allowedOrigins = [
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
const apiLimiter = rateLimit({
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

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummykey',
    key_secret: process.env.RAZORPAY_SECRET || 'dummysecret'
});

// GEMINI AI SDK SETUP
const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });


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


// ==========================================
// --- API ROUTES ---
// ==========================================

app.get('/', (req, res) => {
    res.json({ status: 'NotesToQuiz Production Backend is Live & Secure 🚀' });
});

// ======================================================================= //
// 🔥 1. INDIVIDUAL STUDENT QUIZ GENERATION (FIXED & SECURE) 🔥 //
// =======================================================================_
app.post('/api/v1/generate-quiz', upload.array('files', 5), async (req, res) => {
    let userId = req.user.uid;
    let requiredCredits = 0;
    let creditsDeducted = false;

    try {
        let config = req.body.config ? JSON.parse(req.body.config) : req.body;
        const { subject, questionCount } = config;
        const qCount = Number(questionCount) || 10;
        requiredCredits = Math.max(3, Math.ceil(qCount * 0.5));
        let finalRemainingCredits = "Skipped (Guest)";

        // GUEST EXPLOIT FIX: IP-BASED RATE LIMITING
        if (userId === 'guest_user') {
            const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            const ipHash = crypto.createHash('md5').update(clientIp).digest('hex');
            const ipRef = db.collection('GuestLimits').doc(ipHash);
            await db.runTransaction(async (transaction) => {
                const ipDoc = await transaction.get(ipRef);
                let attempts = 0;
                if (ipDoc.exists) attempts = ipDoc.data().attempts || 0;
                if (attempts >= 2) {
                    throw new Error("Free trial exhausted for this device/IP. Please log in with Google to continue.");
                }
                transaction.set(ipRef, { attempts: attempts + 1, lastUsed: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            });
        }

        // 1. DEDUCT CREDITS SAFELY BEFORE AI CALL
        if (userId !== 'guest_user') {
            const userRef = db.collection('users').doc(userId);
            await db.runTransaction(async (transaction) => {
                const userDoc = await transaction.get(userRef);
                let currentCredits = 30;
                if (userDoc.exists && userDoc.data().credits !== undefined) {
                    currentCredits = Number(userDoc.data().credits);
                }
                if (currentCredits < requiredCredits) throw new Error(`Insufficient credits! Aapke paas ${currentCredits} credits hain.`);
                finalRemainingCredits = currentCredits - requiredCredits;
                transaction.set(userRef, { credits: finalRemainingCredits }, { merge: true });
            });
            creditsDeducted = true; // Mark that we took credits
        }

        const finalSubject = (subject && subject.trim() !== "") ? subject : "Auto-Detected";
        const prompt = `You are an expert academic examiner. Analyze the attached image/file carefully. Generate exactly ${qCount} multiple choice questions (MCQs) STRICTLY based on the visible content. Subject context: "${finalSubject}" WARNING: DO NOT use any markdown formatting, asterisks (*), bold (**), italics, or newlines (\n) INSIDE the JSON values. Keep all text plain and raw. Return ONLY a JSON array of objects strictly matching this schema: [ { "question": "Question text", "options": { "A": "Opt1", "B": "Opt2", "C": "Opt3", "D": "Opt4" }, "correctAnswer": "A", "explanation": "Explanation" } ]`;
        
        const parts = [{ text: prompt }];
        let totalSize = 0;
        if (req.files) {
            req.files.forEach(file => {
                totalSize += file.size;
                parts.push({ inlineData: { data: file.buffer.toString("base64"), mimeType: file.mimetype } });
            });
            if (totalSize > 8 * 1024 * 1024) {
                throw new Error("Uploaded files are too large for AI processing. Please upload compressed PDFs or fewer images (Max 8MB total).");
            }
        }

        // 🔥 2. RETRY LOGIC FOR GEMINI 503 OVERLOAD 🔥
        let response;
        let attempts = 0;
        const maxRetries = 3;

        while (attempts < maxRetries) {
            try {
                attempts++;
                response = await ai.models.generateContent({
                    model: 'gemini-3.6-flash', // Note: Using stable model version to prevent 503 spikes
                    contents: parts
                });
                break; // Agar success ho gaya toh loop se bahar aa jao
            } catch (aiErr) {
                console.warn(`⚠️ Gemini attempt ${attempts} failed (Status: ${aiErr.status || 'Unknown'}). Retrying...`);
                if (attempts >= maxRetries) throw aiErr; // Agar 3 baar fail hua toh final throw karo
                await new Promise(resolve => setTimeout(resolve, attempts * 2000)); // Wait 2s, 4s before retry
            }
        }

        const cleanText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
        const quizArray = JSON.parse(cleanText);

        res.status(200).json({ success: true, quizArray, remainingCredits: finalRemainingCredits });

    } catch (error) {
        console.error("🚨 Individual Generation Error:", error);

        // 🔥 3. AUTO-REFUND MECHANIC (Agar AI fail hua, toh credits wapas karo!)
        if (userId !== 'guest_user' && creditsDeducted) {
            try {
                const userRef = db.collection('users').doc(userId);
                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    if (userDoc.exists) {
                        let currentCredits = Number(userDoc.data().credits || 0);
                        transaction.set(userRef, { credits: currentCredits + requiredCredits }, { merge: true });
                        console.log(`♻️ Auto-refunded ${requiredCredits} credits to user ${userId} due to generation failure.`);
                    }
                });
            } catch (refundErr) {
                console.error("🚨 Refund Transaction Failed:", refundErr);
            }
        }

        res.status(500).json({ 
            success: false, 
            error: "Our AI servers are experiencing high demand right now. Your credits have been safely refunded. Please try again in 1 minute." 
        });
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
            WARNING: DO NOT use markdown formatting inside JSON.
            Return ONLY a raw JSON array: [ { "question": "Q", "options": { "A": "1", "B": "2", "C": "3", "D": "4" }, "correctAnswer": "A", "explanation": "Exp" } ]`;
        }

        const parts = [{ text: prompt }];
        
        // 🔥 AI CRASH PROTECTION (File Size Limiter)
        let totalSize = 0;
        req.files.forEach(file => { 
            totalSize += file.size;
            parts.push({ inlineData: { data: file.buffer.toString("base64"), mimeType: file.mimetype } }); 
        });

        if (totalSize > 8 * 1024 * 1024) {
            throw new Error("Uploaded files are too large for AI processing. Please upload compressed PDFs or fewer images (Max 8MB total).");
        }

        const response = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: parts });
        const quizArray = JSON.parse(response.text.replace(/```json/g, '').replace(/```/g, '').trim());

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
// 🔥 8. RAZORPAY PAYMENT VERIFICATION & CREDIT UPDATE 🔥
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

        const userRef = db.collection('users').doc(req.user.uid);
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            let currentCredits = 0;
            if (userDoc.exists && userDoc.data().credits !== undefined) currentCredits = Number(userDoc.data().credits);
            
            transaction.set(userRef, { 
                credits: currentCredits + Number(creditsToAdd) 
            }, { merge: true });
        });

        res.status(200).json({ success: true, message: "Payment verified successfully." });
    } catch (error) {
        console.error("Payment Verification Error:", error);
        res.status(500).json({ success: false, error: "Failed to verify payment." });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Production Server running on port ${PORT}`);
});
